import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { ReplyInput } from '../../domain/types.ts';
import type { ReplyProcessor } from '../../application/reply-processor.ts';

export function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);

  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') throw new Error('Invalid Redis URL');

  const db = url.pathname === '/' ? 0 : Number(url.pathname.slice(1));

  if (!Number.isInteger(db) || db < 0 || db > 15) throw new Error('Invalid Redis database');

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    db,
    maxRetriesPerRequest: null,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

function parseReply(value: unknown): ReplyInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid reply job');

  const row: Record<string, unknown> = Object.fromEntries(Object.entries(value));

  if (
    typeof row.chatId !== 'string' ||
    !/^[1-9]\d*$/.test(row.chatId) ||
    typeof row.triggerMessageId !== 'string' ||
    !/^\d+$/.test(row.triggerMessageId) ||
    !Number.isSafeInteger(row.generation) ||
    Number(row.generation) < 1 ||
    !Number.isSafeInteger(row.configVersion) ||
    Number(row.configVersion) < 1
  )
    throw new Error('Invalid reply job');

  return {
    chatId: row.chatId,
    triggerMessageId: row.triggerMessageId,
    generation: Number(row.generation),
    configVersion: Number(row.configVersion),
  };
}

export class BullmqRuntime {
  private replyQueue: Queue;
  private indexingQueue: Queue;
  private backfillQueue: Queue;
  private catchupQueue: Queue;
  private replyWorker: Worker | null = null;
  private indexingWorker: Worker | null = null;
  private backfillWorker: Worker | null = null;
  private catchupWorker: Worker | null = null;
  private db: PrismaClient;
  private connection: ConnectionOptions;
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private publishing: Promise<void> | null = null;

  constructor(db: PrismaClient, redisUrl: string) {
    this.db = db;
    this.connection = redisConnection(redisUrl);
    this.replyQueue = new Queue('telegram-replier-reply', { connection: this.connection });
    this.indexingQueue = new Queue('telegram-replier-indexing', { connection: this.connection });
    this.backfillQueue = new Queue('telegram-replier-backfill', { connection: this.connection });
    this.catchupQueue = new Queue('telegram-replier-catchup', { connection: this.connection });
  }

  async publishBatch(now = Date.now(), limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid batch limit');

    const [replyCounts, indexingCounts, backfillCounts, catchupCounts] = await Promise.all([
      this.replyQueue.getJobCounts('waiting', 'delayed', 'active'),
      this.indexingQueue.getJobCounts('waiting', 'delayed', 'active'),
      this.backfillQueue.getJobCounts('waiting', 'delayed', 'active'),
      this.catchupQueue.getJobCounts('waiting', 'delayed', 'active'),
    ]);
    const backlog = [replyCounts, indexingCounts, backfillCounts, catchupCounts].reduce(
      (sum, counts) => sum + (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0),
      0,
    );

    if (backlog >= 1000) return 0;

    const rows = await this.db.jobOutbox.findMany({
      where: { publishedAt: null, attempts: { lt: 10 } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: Math.min(limit, 1000 - backlog),
    });
    let published = 0;

    for (const row of rows) {
      const queue =
        row.taskType === 'reply'
          ? this.replyQueue
          : row.taskType === 'indexing'
            ? this.indexingQueue
            : row.taskType === 'backfill'
              ? this.backfillQueue
              : row.taskType === 'catchup'
                ? this.catchupQueue
                : null;

      if (!queue) throw new Error('Unknown outbox task type');

      try {
        await queue.add(row.taskType, row.payload, {
          jobId: row.id,
          delay: Math.max(0, row.dueAt.getTime() - now),
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: false,
          removeOnFail: false,
        });
        await this.db.jobOutbox.updateMany({
          where: { id: row.id, publishedAt: null },
          data: { publishedAt: new Date(now), attempts: { increment: 1 } },
        });
        published += 1;
      } catch {
        await this.db.jobOutbox.update({
          where: { id: row.id },
          data: { attempts: { increment: 1 } },
        });
      }
    }

    return published;
  }

  startPublisher(onError: (error: unknown) => void, intervalMs = 1000): void {
    if (this.publishTimer) throw new Error('Publisher already started');

    if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000)
      throw new Error('Invalid publisher interval');

    const tick = (): void => {
      if (this.publishing) return;

      this.publishing = this.publishBatch()
        .then(() => undefined)
        .catch(onError)
        .finally(() => {
          this.publishing = null;
        });
    };

    tick();
    this.publishTimer = setInterval(tick, intervalMs);
  }

  async isReady(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        this.replyQueue.waitUntilReady(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Redis readiness timeout')), 2000);
        }),
      ]);

      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  async enqueueIdleFinalization(chatId: string, lastAt: Date): Promise<void> {
    if (!/^[1-9]\d*$/.test(chatId) || !Number.isFinite(lastAt.getTime()))
      throw new Error('Invalid idle chunk');

    const counts = await this.indexingQueue.getJobCounts('waiting', 'delayed', 'active');
    const backlog = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);

    if (backlog >= 1000) return;

    await this.indexingQueue.add(
      'indexing',
      { chatId },
      {
        jobId: `idle-${chatId}-${lastAt.getTime()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
  }

  startWorkers(
    reply: ReplyProcessor,
    indexChat: (chatId: string) => Promise<void>,
    backfillChat: (chatId: string) => Promise<void>,
    catchUpChat: (chatId: string, baselineId: string) => Promise<void>,
    concurrency: number,
    onError: () => void,
  ): void {
    if (this.replyWorker || this.indexingWorker || this.backfillWorker || this.catchupWorker)
      throw new Error('Workers already started');

    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
      throw new Error('Invalid worker concurrency');

    this.replyWorker = new Worker(
      'telegram-replier-reply',
      async (job) => reply.process(parseReply(job.data)),
      { connection: this.connection, concurrency },
    );
    this.indexingWorker = new Worker(
      'telegram-replier-indexing',
      async (job) => {
        const chatId = job.data?.chatId;

        if (typeof chatId !== 'string' || !/^[1-9]\d*$/.test(chatId))
          throw new Error('Invalid indexing job');

        await indexChat(chatId);
      },
      { connection: this.connection, concurrency: 1 },
    );
    this.backfillWorker = new Worker(
      'telegram-replier-backfill',
      async (job) => {
        const chatId = job.data?.chatId;

        if (typeof chatId !== 'string' || !/^[1-9]\d*$/.test(chatId))
          throw new Error('Invalid backfill job');

        await backfillChat(chatId);
      },
      { connection: this.connection, concurrency: 1 },
    );
    this.catchupWorker = new Worker(
      'telegram-replier-catchup',
      async (job) => {
        const chatId = job.data?.chatId;
        const baselineId = job.data?.baselineId;

        if (
          typeof chatId !== 'string' ||
          !/^[1-9]\d*$/.test(chatId) ||
          typeof baselineId !== 'string' ||
          !/^[1-9]\d*$/.test(baselineId)
        )
          throw new Error('Invalid catchup job');

        await catchUpChat(chatId, baselineId);
      },
      { connection: this.connection, concurrency: 1 },
    );

    this.replyWorker.on('error', onError);
    this.indexingWorker.on('error', onError);
    this.backfillWorker.on('error', onError);
    this.catchupWorker.on('error', onError);
  }

  async close(force = false): Promise<void> {
    if (this.publishTimer) clearInterval(this.publishTimer);

    this.publishTimer = null;
    await this.publishing;

    await Promise.all([
      this.replyWorker?.close(force),
      this.indexingWorker?.close(force),
      this.backfillWorker?.close(force),
      this.catchupWorker?.close(force),
      this.replyQueue.close(),
      this.indexingQueue.close(),
      this.backfillQueue.close(),
      this.catchupQueue.close(),
    ]);
  }
}

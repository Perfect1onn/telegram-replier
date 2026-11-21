import OpenAI from 'openai';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { loadSettings } from './config/env.ts';
import { PolicyEngine } from './application/policy-engine.ts';
import { MessageIngestionService } from './application/message-ingestion.service.ts';
import { ContextBuilder } from './application/context-builder.ts';
import { AIService } from './application/ai.service.ts';
import { OutboundDispatcher } from './application/outbound-dispatcher.ts';
import { ReplyProcessor } from './application/reply-processor.ts';
import { TelegramReplier } from './application/telegram-replier.ts';
import { Synchronizer } from './application/synchronizer.ts';
import { PrismaWorkflowStore } from './infrastructure/persistence/prisma-workflow.store.ts';
import { RetentionService } from './infrastructure/persistence/retention.ts';
import { TeleprotoGateway } from './infrastructure/telegram/teleproto.gateway.ts';
import { GatewayLease } from './infrastructure/telegram/gateway-lease.ts';
import { OpenAIProvider } from './infrastructure/llm/openai.provider.ts';
import { OpenAIEmbeddings } from './infrastructure/rag/openai-embeddings.ts';
import { PgVectorRepository } from './infrastructure/rag/pgvector-repository.ts';
import { RagService } from './infrastructure/rag/rag-service.ts';
import { BullmqRuntime } from './infrastructure/queue/bullmq-runtime.ts';
import { createAdminApi } from './infrastructure/admin/admin-api.ts';

const logger = pino({
  base: null,
  redact: ['token', 'password', 'secret', 'text', 'session', 'apiKey'],
});

async function main(): Promise<void> {
  const settings = loadSettings(process.env);
  const db = new PrismaClient();
  let queue: BullmqRuntime | null = null;
  let replier: TelegramReplier | null = null;
  let admin: ReturnType<typeof createAdminApi> | null = null;
  let lease: GatewayLease | null = null;
  let stopping = false;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let sweeping: Promise<void> | null = null;
  let retentionTimer: ReturnType<typeof setInterval> | null = null;
  let retaining: Promise<void> | null = null;

  const shutdown = async (): Promise<void> => {
    if (stopping) return;

    stopping = true;
    logger.info({ event: 'shutdown_started' });

    if (idleTimer) clearInterval(idleTimer);

    if (retentionTimer) clearInterval(retentionTimer);

    idleTimer = null;
    retentionTimer = null;
    await sweeping;
    await retaining;

    const results = await Promise.allSettled([
      replier?.stop(10000),
      queue?.close(true),
      admin?.close(),
    ]);

    if (results.some((result) => result.status === 'rejected'))
      logger.error({ event: 'shutdown_component_failed' });

    await lease?.release();
    await db.$disconnect();
    logger.info({ event: 'shutdown_complete' });
  };

  try {
    await db.$connect();

    const store = new PrismaWorkflowStore(db);
    const retention = new RetentionService(db, settings.retentionDays);
    const recovered = await store.recoverInterruptedSends();

    if (recovered) logger.warn({ event: 'send_outcome_unknown', count: recovered });

    lease = new GatewayLease(settings.redisUrl, settings.expectedAccountId, () => {
      logger.error({ event: 'gateway_lease_lost' });
      void shutdown();
    });
    await lease.acquire();

    const enabled = async (): Promise<boolean> => {
      if (!settings.autoreplyEnabled) return false;

      if (!(await lease?.renew())) return false;

      const system = await db.systemState.findUnique({ where: { id: 1 } });

      return system?.paused === false;
    };
    const policy = new PolicyEngine(store, enabled);
    const client = new OpenAI({ apiKey: settings.openaiApiKey, maxRetries: 0 });
    const rag = new RagService(
      db,
      new OpenAIEmbeddings(client, settings.embeddingModel),
      new PgVectorRepository(db, settings.embeddingModel),
    );
    const gateway = new TeleprotoGateway(
      {
        apiId: settings.telegramApiId,
        apiHash: settings.telegramApiHash,
        expectedAccountId: settings.expectedAccountId,
        sessionFile: settings.sessionFile,
      },
      policy,
      () => logger.error({ event: 'telegram_event_failed' }),
    );
    const dispatcher = new OutboundDispatcher(store, policy, gateway);
    const processor = new ReplyProcessor({
      store,
      policy,
      context: new ContextBuilder(store, policy, rag),
      ai: new AIService(new OpenAIProvider(client, settings.model)),
      dispatcher,
      pricing: {
        prices: settings.prices,
        version: settings.priceVersion,
        effectiveAt: settings.priceEffectiveAt,
        dailyBudgetUsd: settings.dailyBudgetUsd,
      },
      model: settings.model,
    });
    const ingestion = new MessageIngestionService(policy, store);
    const synchronizer = new Synchronizer(store, policy, gateway);

    queue = new BullmqRuntime(db, settings.redisUrl);

    const adminPublicKeyPem = await readFile(settings.adminPublicKeyFile, 'utf8');

    admin = createAdminApi({
      jwtSecret: settings.adminJwtSecret,
      publicKeyPem: adminPublicKeyPem,
      autoreplyEnabled: settings.autoreplyEnabled,
      db,
      store,
      dispatcher,
      gateway,
      ready: async () => {
        if (!replier?.isRunning() || !queue || !lease?.isHeld()) return false;

        await db.$queryRaw`SELECT 1`;

        return queue.isReady();
      },
    });
    await admin.listen({ host: settings.adminHost, port: settings.adminPort });

    let cursor: string | undefined;

    for (;;) {
      const chats = await db.allowedChat.findMany({
        orderBy: { chatId: 'asc' },
        take: 100,
        ...(cursor ? { cursor: { chatId: cursor }, skip: 1 } : {}),
      });

      for (const chat of chats)
        if (chat.enabled && chat.mode !== 'OFF') await store.enqueueCatchUp(chat.chatId);

      if (chats.length < 100) break;

      cursor = chats.at(-1)?.chatId;
    }

    replier = new TelegramReplier({
      gateway,
      handle: (message) => ingestion.handle(message),
      onError: () => logger.error({ event: 'ingestion_failed' }),
    });
    await replier.start();

    queue.startWorkers(
      processor,
      (chatId) => rag.indexChat(chatId),
      async (chatId) => {
        if (await synchronizer.backfillChat(chatId)) await rag.reindexChat(chatId);
      },
      async (chatId, baselineId) => {
        if (await synchronizer.syncMissingMessages(chatId, baselineId))
          await rag.reindexChat(chatId);
      },
      settings.workerConcurrency,
      () => logger.error({ event: 'queue_worker_failed' }),
    );
    queue.startPublisher(() => logger.error({ event: 'outbox_publish_failed' }));

    const sweepIdle = (): void => {
      if (sweeping || !queue) return;

      sweeping = (async () => {
        const threshold = new Date(Date.now() - 1800000);
        const stale = await db.$queryRaw<Array<{ chat_id: string; open_last_at: Date }>>`
          SELECT i.chat_id, i.open_last_at FROM indexing_state i
          JOIN allowed_chats c ON c.chat_id = i.chat_id
          WHERE i.open_last_at <= ${threshold} AND c.enabled AND c.mode <> 'OFF'
          ORDER BY i.open_last_at LIMIT 100`;

        for (const row of stale)
          await queue?.enqueueIdleFinalization(row.chat_id, row.open_last_at);
      })()
        .catch(() => logger.error({ event: 'idle_sweep_failed' }))
        .finally(() => {
          sweeping = null;
        });
    };

    sweepIdle();
    idleTimer = setInterval(sweepIdle, 60000);

    const sweepRetention = (): void => {
      if (retaining) return;

      retaining = retention
        .run(new Date(), () => stopping)
        .then((count) => {
          if (count) logger.info({ event: 'retention_applied', chatCount: count });
        })
        .catch(() => logger.error({ event: 'retention_failed' }))
        .finally(() => {
          retaining = null;
        });
    };

    sweepRetention();
    retentionTimer = setInterval(sweepRetention, 86400000);

    logger.info({ event: 'ready', autoReplyEnabled: settings.autoreplyEnabled });

    process.once('SIGINT', () => {
      void shutdown();
    });
    process.once('SIGTERM', () => {
      void shutdown();
    });
  } catch {
    logger.error({ event: 'startup_failed' });
    process.exitCode = 1;
    await shutdown();
  }
}

void main();

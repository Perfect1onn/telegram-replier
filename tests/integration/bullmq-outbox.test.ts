import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { BullmqRuntime, redisConnection } from '../../src/infrastructure/queue/bullmq-runtime.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

if (!databaseUrl || !redisUrl) throw new Error('TEST_DATABASE_URL and TEST_REDIS_URL are required');

const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const runtime = new BullmqRuntime(db, redisUrl);
const replyQueue = new Queue('telegram-replier-reply', { connection: redisConnection(redisUrl) });
const indexingQueue = new Queue('telegram-replier-indexing', {
  connection: redisConnection(redisUrl),
});

after(async () => {
  await runtime.close();
  await replyQueue.close();
  await indexingQueue.close();
  await db.$disconnect();
});

test('outbox is published once with a durable BullMQ job id', async () => {
  const chatId = String(BigInt(`3${Date.now()}`) + BigInt(Math.floor(Math.random() * 1000)));
  const id = randomUUID();

  await db.allowedChat.create({ data: { chatId, enabled: true, mode: 'AUTO' } });
  await db.jobOutbox.create({
    data: {
      id,
      chatId,
      generation: 1,
      taskType: 'reply',
      payload: { chatId, generation: 1, configVersion: 1, triggerMessageId: '300' },
      dueAt: new Date(Date.now() + 1000),
    },
  });

  assert.ok((await runtime.publishBatch()) >= 1);
  assert.ok(await replyQueue.getJob(id));
  assert.ok((await db.jobOutbox.findUniqueOrThrow({ where: { id } })).publishedAt);
  await runtime.publishBatch();
  assert.ok(await replyQueue.getJob(id));
  await runtime.enqueueIdleFinalization(chatId, new Date(0));
  await runtime.enqueueIdleFinalization(chatId, new Date(0));
  assert.ok(await indexingQueue.getJob(`idle-${chatId}-0`));
});

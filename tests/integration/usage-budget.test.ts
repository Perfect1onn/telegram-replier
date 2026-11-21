import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { PrismaWorkflowStore } from '../../src/infrastructure/persistence/prisma-workflow.store.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const store = new PrismaWorkflowStore(db);

after(async () => db.$disconnect());

test('budget reservation is durable, serialized, and completed with priced usage', async () => {
  const chatId = String(BigInt(`1${Date.now()}1`));
  const dayStart = new Date();

  dayStart.setUTCHours(0, 0, 0, 0);

  const prior = await db.llmUsage.aggregate({
    where: { createdAt: { gte: dayStart }, status: { in: ['RESERVED', 'COMPLETED', 'UNKNOWN'] } },
    _sum: { estimatedCostUsd: true },
  });
  const pricing = {
    prices: { input: 100, output: 100, cached: 50 },
    version: 'test-2026-11-21',
    effectiveAt: new Date('2026-11-21'),
    dailyBudgetUsd: (prior._sum.estimatedCostUsd?.toNumber() ?? 0) + 0.3,
  };

  await store.updateChat(chatId, { enabled: true, mode: 'DRAFT' }, 0);
  await store.setPaused(false);

  const first = await store.reserveUsage(chatId, 'fake-model', 1000, pricing);

  assert.ok(first);
  assert.equal(await store.reserveUsage(chatId, 'fake-model', 1000, pricing), null);

  await store.completeUsage(
    first,
    {
      text: 'hello',
      model: 'fake-model',
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
    },
    pricing,
  );

  const second = await store.reserveUsage(chatId, 'fake-model', 1000, pricing);

  assert.ok(second);
  await store.unknownUsage(second);
  assert.equal(await store.reserveUsage(chatId, 'fake-model', 1000, pricing), null);

  const recorded = await db.llmUsage.findUniqueOrThrow({ where: { requestId: first } });

  assert.equal(recorded.status, 'COMPLETED');
  assert.equal(recorded.priceVersion, pricing.version);
  assert.equal(recorded.estimatedCostUsd?.toNumber(), 0.011);
});

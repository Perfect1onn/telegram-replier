import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';
import { ChatSummaryService } from '../../src/application/chat-summary-service.ts';
import { PrismaWorkflowStore } from '../../src/infrastructure/persistence/prisma-workflow.store.ts';
import { PersonalMemory } from '../../src/infrastructure/persistence/personal-memory.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

after(async () => db.$disconnect());

test('six-month summary processes each message and becomes available only when complete', async () => {
  const chatId = String(BigInt(`7${Date.now()}`));
  const now = new Date();
  const store = new PrismaWorkflowStore(db);
  const inputs: string[] = [];
  const client = new OpenAI({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (_url, init) => {
      inputs.push(String(init?.body));

      return new Response(
        JSON.stringify({
          id: 'resp_test',
          object: 'response',
          status: 'completed',
          model: 'test-model',
          output: [
            {
              type: 'message',
              id: 'msg_test',
              status: 'completed',
              role: 'assistant',
              content: [
                { type: 'output_text', text: 'Договорились созвониться.', annotations: [] },
              ],
            },
          ],
          usage: {
            input_tokens: 30,
            output_tokens: 12,
            total_tokens: 42,
            input_tokens_details: { cached_tokens: 0 },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const service = new ChatSummaryService(db, store, client, 'test-model', {
    prices: { input: 1, output: 1, cached: 1 },
    version: 'test',
    effectiveAt: now,
    dailyBudgetUsd: 100,
  });

  await db.systemState.upsert({
    where: { id: 1 },
    create: { id: 1, paused: false },
    update: { paused: false },
  });
  await db.allowedChat.create({ data: { chatId, enabled: true, mode: 'DRAFT' } });
  await db.syncCheckpoint.create({ data: { chatId, kind: 'BACKFILL', state: 'COMPLETE' } });
  await db.message.createMany({
    data: [
      {
        chatId,
        messageId: '1',
        senderId: '42',
        direction: 'OUTGOING',
        source: 'TELEGRAM',
        text: 'Привет',
        occurredAt: new Date(now.getTime() - 86400000),
      },
      {
        chatId,
        messageId: '2',
        senderId: '43',
        direction: 'INCOMING',
        source: 'TELEGRAM',
        text: 'Созвонимся?',
        occurredAt: now,
      },
      {
        chatId,
        messageId: '3',
        senderId: '43',
        direction: 'INCOMING',
        source: 'TELEGRAM',
        text: 'Очень старое',
        occurredAt: new Date(now.getTime() - 184 * 86400000),
      },
    ],
  });

  assert.equal(await service.step(chatId), true);
  assert.equal(await new PersonalMemory(db).getChatSummary(chatId), '');
  assert.equal(await service.step(chatId), true);
  assert.equal(await new PersonalMemory(db).getChatSummary(chatId), 'Договорились созвониться.');
  assert.equal((await db.chatSummary.findUniqueOrThrow({ where: { chatId } })).processed, 2);
  assert.equal(inputs.length, 1);
  assert.ok(inputs[0]?.includes('Привет'));
  assert.ok(inputs[0]?.includes('Созвонимся?'));
  assert.ok(!inputs[0]?.includes('Очень старое'));
});

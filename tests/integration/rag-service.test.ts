import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { RagService } from '../../src/infrastructure/rag/rag-service.ts';
import { PgVectorRepository } from '../../src/infrastructure/rag/pgvector-repository.ts';
import type { IEmbeddingService } from '../../src/ports/contracts.ts';
import { PrismaWorkflowStore } from '../../src/infrastructure/persistence/prisma-workflow.store.ts';
import { Synchronizer } from '../../src/application/synchronizer.ts';
import { PolicyEngine } from '../../src/application/policy-engine.ts';
import { FakeGateway } from '../../src/infrastructure/testing/fakes.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let embedded = 0;
const vector = new Array<number>(1536).fill(0);

vector[0] = 1;

const fakeEmbeddings: IEmbeddingService = {
  async embedDocuments(texts) {
    embedded += texts.length;

    return texts.map(() => vector);
  },
  async embedQuery() {
    return vector;
  },
};
const rag = new RagService(db, fakeEmbeddings, new PgVectorRepository(db, 'test-1536'));

after(async () => db.$disconnect());

test('indexing checkpoint avoids duplicate embeddings and search stays scoped', async () => {
  const chatId = String(BigInt(`8${Date.now()}`));
  const other = String(BigInt(`9${Date.now()}`));

  await db.allowedChat.createMany({
    data: [
      { chatId, enabled: true, mode: 'DRAFT' },
      { chatId: other, enabled: true, mode: 'DRAFT' },
    ],
  });
  await db.message.create({
    data: {
      chatId,
      messageId: '1',
      senderId: chatId,
      direction: 'INCOMING',
      source: 'TELEGRAM',
      text: 'old conversation',
      occurredAt: new Date(Date.now() - 3600000),
    },
  });

  await rag.indexChat(chatId);

  assert.equal(embedded, 1);
  assert.deepEqual(
    (await rag.searchRelevantContext(chatId, 'conversation', 5)).map((item) => item.chatId),
    [chatId],
  );
  assert.deepEqual(await rag.searchRelevantContext(other, 'conversation', 5), []);

  await rag.indexChat(chatId);

  assert.equal(embedded, 1);
  assert.equal(
    (await db.indexingState.findUniqueOrThrow({ where: { chatId } })).lastMessageId,
    '1',
  );
});

test('backfill persists old history and reindexes without reply operations', async () => {
  const chatId = String(BigInt(`2${Date.now()}2`));
  const store = new PrismaWorkflowStore(db);
  const gateway = new FakeGateway();
  const synchronizer = new Synchronizer(store, new PolicyEngine(store, () => false), gateway);

  await store.updateChat(chatId, { enabled: true, mode: 'DRAFT' }, 0);
  gateway.history = [
    {
      chatId,
      messageId: '1',
      senderId: chatId,
      direction: 'INCOMING',
      source: 'TELEGRAM',
      text: 'historical message',
      occurredAt: new Date(Date.now() - 3600000),
    },
  ];

  await synchronizer.backfillChat(chatId);
  await rag.reindexChat(chatId);

  assert.equal((await store.checkpoint(chatId)).complete, true);
  assert.equal(await db.replyOperation.count({ where: { chatId } }), 0);
  assert.equal((await rag.searchRelevantContext(chatId, 'historical', 5)).length, 1);
});

test('catch-up resumes from a known Telegram ID without historical replies', async () => {
  const chatId = String(BigInt(`3${Date.now()}3`));
  const store = new PrismaWorkflowStore(db);
  const gateway = new FakeGateway();
  const synchronizer = new Synchronizer(store, new PolicyEngine(store, () => false), gateway);
  const now = Date.now();

  await store.updateChat(chatId, { enabled: true, mode: 'DRAFT' }, 0);
  await store.ingest(
    {
      chatId,
      messageId: '10',
      senderId: chatId,
      direction: 'INCOMING',
      source: 'TELEGRAM',
      text: 'known',
      occurredAt: new Date(now - 3000),
    },
    now,
  );
  gateway.history = [12, 11, 10].map((id) => ({
    chatId,
    messageId: String(id),
    senderId: chatId,
    direction: 'INCOMING' as const,
    source: 'TELEGRAM' as const,
    text: `message ${id}`,
    occurredAt: new Date(now - (12 - id) * 1000),
  }));

  assert.equal(await synchronizer.syncMissingMessages(chatId, '10'), true);
  assert.equal((await store.checkpoint(chatId, 'CATCHUP')).complete, true);
  assert.equal(await store.lastKnownMessageId(chatId), '12');
  assert.equal(await db.message.count({ where: { chatId } }), 3);
  assert.equal(await db.replyOperation.count({ where: { chatId } }), 1);
});

test('idle open chunk finalizes without a new message', async () => {
  const chatId = String(BigInt(`4${Date.now()}4`));

  await db.allowedChat.create({ data: { chatId, enabled: true, mode: 'DRAFT' } });
  await db.message.create({
    data: {
      chatId,
      messageId: '1',
      senderId: chatId,
      direction: 'INCOMING',
      source: 'TELEGRAM',
      text: 'idle memory',
      occurredAt: new Date(),
    },
  });

  await rag.indexChat(chatId);

  assert.equal(await db.conversationChunk.count({ where: { chatId } }), 0);

  await db.indexingState.update({
    where: { chatId },
    data: { openLastAt: new Date(Date.now() - 3600000) },
  });
  await rag.indexChat(chatId);

  assert.equal(await db.conversationChunk.count({ where: { chatId } }), 1);
  assert.equal(
    (await db.indexingState.findUniqueOrThrow({ where: { chatId } })).openParts.length,
    0,
  );
});

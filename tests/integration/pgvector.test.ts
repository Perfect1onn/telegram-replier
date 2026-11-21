import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { PgVectorRepository } from '../../src/infrastructure/rag/pgvector-repository.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const vectors = new PgVectorRepository(db, `test-1536-${randomUUID()}`);

after(async () => db.$disconnect());

test('pgvector upsert is idempotent and search spans chats', async () => {
  const a = String(BigInt(`5${Date.now()}`));
  const b = String(BigInt(`6${Date.now()}`));

  await db.allowedChat.createMany({
    data: [
      { chatId: a, enabled: true, mode: 'DRAFT' },
      { chatId: b, enabled: true, mode: 'DRAFT' },
    ],
  });
  await db.message.createMany({
    data: [
      {
        chatId: a,
        messageId: '1',
        senderId: '1',
        direction: 'OUTGOING',
        source: 'TELEGRAM',
        text: 'Мой стиль?',
        occurredAt: new Date(),
      },
      {
        chatId: b,
        messageId: '2',
        senderId: '2',
        direction: 'INCOMING',
        source: 'TELEGRAM',
        text: 'Не мой стиль',
        occurredAt: new Date(),
      },
    ],
  });

  const first = new Array<number>(1536).fill(0);
  const second = new Array<number>(1536).fill(0);

  first[0] = 1;
  second[1] = 1;

  const chunkA = {
    id: randomUUID(),
    chatId: a,
    content: 'Это тестовый проект по векторному поиску',
    messageIds: ['1'],
    tokenCount: 5,
  };
  const chunkB = { id: randomUUID(), chatId: b, content: 'beta', messageIds: ['2'], tokenCount: 4 };

  await vectors.upsertChunks(a, [chunkA], [first]);
  await vectors.upsertChunks(a, [chunkA], [first]);
  await vectors.upsertChunks(b, [chunkB], [second]);

  assert.equal(await db.conversationChunk.count({ where: { chatId: a } }), 1);
  assert.deepEqual(
    (await vectors.search(first, 1)).map((row) => row.content),
    ['Это тестовый проект по векторному поиску'],
  );
  assert.deepEqual(
    (await vectors.search(second, 1)).map((row) => row.content),
    ['beta'],
  );
  assert.deepEqual(
    new Set((await vectors.search(first, 2)).map((row) => row.chatId)),
    new Set([a, b]),
  );
  assert.deepEqual(
    (await vectors.searchOwner(first, 2, new Date(Date.now() - 183 * 86400000))).map(
      (row) => row.chatId,
    ),
    [a],
  );
  assert.deepEqual(
    (await vectors.searchLexical('расскажи о проекте', 2)).map((row) => row.chatId),
    [a],
  );
  await assert.rejects(vectors.search([1], 5));
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { PgVectorRepository } from '../../src/infrastructure/rag/pgvector-repository.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const vectors = new PgVectorRepository(db, 'test-1536');

after(async () => db.$disconnect());

test('pgvector upsert is idempotent and search is scoped to one chat', async () => {
  const a = String(BigInt(`5${Date.now()}`));
  const b = String(BigInt(`6${Date.now()}`));

  await db.allowedChat.createMany({ data: [{ chatId: a }, { chatId: b }] });

  const first = new Array<number>(1536).fill(0);
  const second = new Array<number>(1536).fill(0);

  first[0] = 1;
  second[1] = 1;

  const chunkA = {
    id: randomUUID(),
    chatId: a,
    content: 'alpha',
    messageIds: ['1'],
    tokenCount: 5,
  };
  const chunkB = { id: randomUUID(), chatId: b, content: 'beta', messageIds: ['2'], tokenCount: 4 };

  await vectors.upsertChunks(a, [chunkA], [first]);
  await vectors.upsertChunks(a, [chunkA], [first]);
  await vectors.upsertChunks(b, [chunkB], [second]);

  assert.equal(await db.conversationChunk.count({ where: { chatId: a } }), 1);
  assert.deepEqual(
    (await vectors.search(a, first, 5)).map((row) => row.content),
    ['alpha'],
  );
  assert.deepEqual(
    (await vectors.search(b, second, 5)).map((row) => row.content),
    ['beta'],
  );
  await assert.rejects(vectors.search(a, [1], 5));
});

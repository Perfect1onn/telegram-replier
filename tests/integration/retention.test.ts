import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { RetentionService } from '../../src/infrastructure/persistence/retention.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

after(async () => db.$disconnect());

test('retention removes old text and stale chunks while preserving recent messages', async () => {
  const chatId = String(BigInt(`7${Date.now()}7`));
  const old = new Date(Date.now() - 31 * 86400000);

  await db.allowedChat.create({ data: { chatId, enabled: true, mode: 'DRAFT' } });
  await db.message.createMany({
    data: [
      {
        chatId,
        messageId: '1',
        senderId: chatId,
        direction: 'INCOMING',
        source: 'TELEGRAM',
        text: 'old private text',
        occurredAt: old,
      },
      {
        chatId,
        messageId: '2',
        senderId: chatId,
        direction: 'INCOMING',
        source: 'TELEGRAM',
        text: 'recent text',
        occurredAt: new Date(),
      },
    ],
  });
  await db.conversationChunk.create({
    data: {
      id: randomUUID(),
      chatId,
      content: 'old private text',
      firstMessageId: '1',
      lastMessageId: '1',
      messageIds: ['1'],
      status: 'FINALIZED',
      tokenCount: 16,
      embeddingModel: 'test-1536',
      contentHash: randomUUID(),
    },
  });
  await db.conversationChunk.create({
    data: {
      id: randomUUID(),
      chatId,
      content: 'recent text',
      firstMessageId: '2',
      lastMessageId: '2',
      messageIds: ['2'],
      status: 'FINALIZED',
      tokenCount: 11,
      embeddingModel: 'test-1536',
      contentHash: randomUUID(),
    },
  });
  await db.indexingState.create({
    data: {
      chatId,
      openParts: ['old private text'],
      openIds: ['1'],
      openLastAt: old,
      openLastId: '1',
    },
  });

  assert.ok((await new RetentionService(db, 30).run()) >= 1);
  assert.deepEqual(
    (await db.message.findMany({ where: { chatId } })).map((row) => row.text),
    ['recent text'],
  );
  assert.deepEqual(
    (await db.conversationChunk.findMany({ where: { chatId } })).map((row) => row.content),
    ['recent text'],
  );
  assert.equal(await db.indexingState.count({ where: { chatId } }), 0);
});

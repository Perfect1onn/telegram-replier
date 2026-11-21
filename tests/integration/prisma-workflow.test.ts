import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { PrismaWorkflowStore } from '../../src/infrastructure/persistence/prisma-workflow.store.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for integration tests');

{
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const store = new PrismaWorkflowStore(db);

  after(async () => db.$disconnect());

  test('atomic ingestion and early AI outgoing event do not invalidate send', async () => {
    const chatId = String(BigInt(`1${Date.now()}`) + BigInt(Math.floor(Math.random() * 1000)));
    const chat = await store.updateChat(chatId, { enabled: true, mode: 'AUTO' }, 0);

    assert.equal(chat.version, 1);
    await assert.rejects(store.updateChat(chatId, { mode: 'OFF' }, 0));

    const now = Date.now();

    await store.ingest(
      {
        chatId,
        messageId: '100',
        senderId: chatId,
        direction: 'INCOMING',
        source: 'TELEGRAM',
        text: 'hello',
        occurredAt: new Date(now),
      },
      now,
    );

    const operation = await db.replyOperation.findFirstOrThrow({ where: { chatId } });
    const input = {
      chatId,
      generation: Number(operation.generation),
      configVersion: chat.version,
      triggerMessageId: '100',
    };

    assert.equal(await db.jobOutbox.count({ where: { chatId } }), 2);
    await store.setPaused(false);

    const claim = await store.claimSend(
      input,
      {
        text: `test ${randomUUID()}`,
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      },
      false,
      now,
    );

    assert.equal(claim?.status, 'SENDING');

    if (!claim) throw new Error('Send was not claimed');

    assert.equal(await store.current(input), false);

    await store.ingest(
      {
        chatId,
        messageId: '101',
        senderId: 'self',
        direction: 'OUTGOING',
        source: 'TELEGRAM',
        text: 'reply',
        occurredAt: new Date(now + 1),
      },
      now + 1,
    );

    assert.equal(
      (await db.chatRuntimeState.findUniqueOrThrow({ where: { chatId } })).generation,
      2n,
    );
    assert.equal(await db.deferredOutgoing.count({ where: { chatId } }), 1);
    await assert.rejects(store.updateChat(chatId, { mode: 'OFF' }, 1));

    await store.finishSend(claim.id, { messageId: '101' });

    assert.equal(
      (
        await db.message.findUniqueOrThrow({
          where: {
            chatId_messageId: { chatId, messageId: '101' },
          },
        })
      ).source,
      'AI',
    );
    assert.equal(await db.deferredOutgoing.count({ where: { chatId } }), 0);
    assert.equal(
      (await db.chatRuntimeState.findUniqueOrThrow({ where: { chatId } })).generation,
      2n,
    );

    await store.updateChat(chatId, { mode: 'OFF' }, 1);
  });

  test('restart recovery makes an in-flight send UNKNOWN without retry', async () => {
    const chatId = String(BigInt(`2${Date.now()}`) + BigInt(Math.floor(Math.random() * 1000)));
    const chat = await store.updateChat(chatId, { enabled: true, mode: 'AUTO' }, 0);
    const now = Date.now();

    await store.ingest(
      {
        chatId,
        messageId: '200',
        senderId: chatId,
        direction: 'INCOMING',
        source: 'TELEGRAM',
        text: 'hello',
        occurredAt: new Date(now),
      },
      now,
    );

    const input = { chatId, generation: 2, configVersion: chat.version, triggerMessageId: '200' };
    const answer = {
      text: 'reply',
      model: 'fake',
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    };
    const claim = await store.claimSend(input, answer, false, now);

    assert.equal(claim?.status, 'SENDING');

    if (!claim) throw new Error('Send was not claimed');

    assert.ok((await store.recoverInterruptedSends()) >= 1);
    assert.equal(
      (await db.replyOperation.findUniqueOrThrow({ where: { id: claim.id } })).status,
      'UNKNOWN',
    );
    assert.equal(await store.claimSend(input, answer, false, now), null);
    await assert.rejects(store.updateChat(chatId, { mode: 'OFF' }, 1));
  });

  test('message edits invalidate pending reply and stale RAG content', async () => {
    const chatId = String(BigInt(`4${Date.now()}4`));
    const now = Date.now();

    await store.updateChat(chatId, { enabled: true, mode: 'DRAFT' }, 0);
    await store.ingest(
      {
        chatId,
        messageId: '400',
        senderId: chatId,
        direction: 'INCOMING',
        source: 'TELEGRAM',
        text: 'before',
        occurredAt: new Date(now),
      },
      now,
    );
    await db.conversationChunk.create({
      data: {
        id: randomUUID(),
        chatId,
        content: 'before',
        firstMessageId: '400',
        lastMessageId: '400',
        messageIds: ['400'],
        status: 'FINALIZED',
        tokenCount: 6,
        embeddingModel: 'test-1536',
        contentHash: randomUUID(),
      },
    });
    await db.indexingState.create({ data: { chatId } });

    await store.ingest(
      {
        chatId,
        messageId: '400',
        senderId: chatId,
        direction: 'INCOMING',
        source: 'TELEGRAM',
        text: 'after',
        occurredAt: new Date(now),
        editedAt: new Date(now + 1000),
      },
      now + 1000,
    );

    assert.equal(
      (
        await db.message.findUniqueOrThrow({
          where: {
            chatId_messageId: { chatId, messageId: '400' },
          },
        })
      ).text,
      'after',
    );
    assert.equal(
      (await db.replyOperation.findFirstOrThrow({ where: { chatId } })).status,
      'CANCELLED',
    );
    assert.equal(await db.conversationChunk.count({ where: { chatId } }), 0);
    assert.equal(await db.indexingState.count({ where: { chatId } }), 0);

    await store.ingest(
      {
        chatId,
        messageId: '400',
        senderId: chatId,
        direction: 'INCOMING',
        source: 'TELEGRAM',
        text: 'stale',
        occurredAt: new Date(now),
        editedAt: new Date(now + 500),
      },
      now + 1500,
    );

    assert.equal(
      (
        await db.message.findUniqueOrThrow({
          where: {
            chatId_messageId: { chatId, messageId: '400' },
          },
        })
      ).text,
      'after',
    );
  });
}

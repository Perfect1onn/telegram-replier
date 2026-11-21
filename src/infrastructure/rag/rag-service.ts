import { Prisma, type Message, type PrismaClient } from '@prisma/client';
import { setTimeout as wait } from 'node:timers/promises';
import {
  ConversationChunker,
  type Chunk,
  type OpenChunkState,
} from '../../application/conversation-chunker.ts';
import type { RetrievedChunk } from '../../domain/types.ts';
import type { IEmbeddingService, IRagService } from '../../ports/contracts.ts';
import { mapMessage } from '../persistence/message.mapper.ts';
import { PgVectorRepository } from './pgvector-repository.ts';

export class RagService implements IRagService {
  private db: PrismaClient;
  private embeddings: IEmbeddingService;
  private vectors: PgVectorRepository;
  private chunker = new ConversationChunker();

  constructor(db: PrismaClient, embeddings: IEmbeddingService, vectors: PgVectorRepository) {
    this.db = db;
    this.embeddings = embeddings;
    this.vectors = vectors;
  }

  async searchRelevantContext(
    chatId: string,
    query: string,
    limit: number,
  ): Promise<RetrievedChunk[]> {
    if (!query.trim()) return [];

    const chat = await this.db.allowedChat.findUnique({ where: { chatId } });

    if (!chat?.enabled || chat.mode === 'OFF') return [];

    const lexical = await this.vectors.searchLexical(query, 5).catch(() => []);
    let semantic: RetrievedChunk[] = [];

    try {
      const vector = await this.embeddings.embedQuery(query);

      semantic = await this.vectors.search(vector, 10);
    } catch (error) {
      if (!lexical.length) throw error;
    }

    const chunks = [...lexical, ...semantic];
    const selected: RetrievedChunk[] = [];
    const seen = new Set<string>();
    const since = new Date(Date.now() - 183 * 86400000);

    for (const chunk of chunks) {
      if (seen.has(chunk.id)) continue;

      seen.add(chunk.id);

      if (chunk.chatId === chatId) {
        selected.push(chunk);
      } else {
        const ownerMessages = await this.db.message.findMany({
          where: {
            chatId: chunk.chatId,
            messageId: { in: chunk.messageIds },
            direction: 'OUTGOING',
            source: 'TELEGRAM',
            occurredAt: { gte: since },
          },
          orderBy: { occurredAt: 'asc' },
        });

        if (ownerMessages.length)
          selected.push({
            ...chunk,
            content: ownerMessages.map((message) => message.text).join('\n'),
            messageIds: ownerMessages.map((message) => message.messageId),
          });
      }

      if (selected.length >= limit) break;
    }

    return selected;
  }

  async searchOwnerExamples(query: string, limit: number): Promise<string[]> {
    if (!query.trim()) return [];

    if (!Number.isInteger(limit) || limit < 1 || limit > 6)
      throw new Error('Invalid example limit');

    const vector = await this.embeddings.embedQuery(query);
    const since = new Date(Date.now() - 183 * 86400000);
    const chunks = await this.vectors.searchOwner(vector, 10, since);
    const examples: string[] = [];

    for (const chunk of chunks) {
      const messages = await this.db.message.findMany({
        where: {
          chatId: chunk.chatId,
          messageId: { in: chunk.messageIds },
          direction: 'OUTGOING',
          source: 'TELEGRAM',
          occurredAt: { gte: since },
        },
        orderBy: { occurredAt: 'asc' },
      });

      for (const message of messages) {
        if (!message.text.trim() || examples.includes(message.text)) continue;

        examples.push(message.text.slice(0, 1000));

        if (examples.length >= limit) return examples;
      }
    }

    return examples;
  }

  async indexChat(chatId: string): Promise<void> {
    for (;;) {
      try {
        if (!(await this.indexBatch(chatId))) return;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Concurrent indexing') throw error;

        await wait(250);
      }
    }
  }

  async reindexChat(chatId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT chat_id FROM allowed_chats WHERE chat_id = ${chatId} FOR UPDATE`;

      const chat = await tx.allowedChat.findUnique({ where: { chatId } });

      if (!chat?.enabled || chat.mode === 'OFF') return;

      await tx.conversationChunk.deleteMany({ where: { chatId } });
      await tx.indexingState.deleteMany({ where: { chatId } });
    });

    await this.indexChat(chatId);
  }

  private async indexBatch(chatId: string): Promise<boolean> {
    const chat = await this.db.allowedChat.findUnique({ where: { chatId } });

    if (!chat?.enabled || chat.mode === 'OFF') return false;

    const state = await this.db.indexingState.upsert({
      where: { chatId },
      create: { chatId },
      update: {},
    });
    const cursor =
      state.lastOccurredAt && state.lastMessageId
        ? Prisma.sql`AND (occurred_at > ${state.lastOccurredAt} OR
          (occurred_at = ${state.lastOccurredAt} AND message_id::bigint > ${BigInt(state.lastMessageId)}))`
        : Prisma.empty;
    const rows = await this.db.$queryRaw<Message[]>`
      SELECT chat_id AS "chatId", message_id AS "messageId", sender_id AS "senderId",
        direction, source, text, occurred_at AS "occurredAt",
        reply_to_message_id AS "replyToMessageId", edited_at AS "editedAt",
        created_at AS "createdAt"
      FROM messages WHERE chat_id = ${chatId} ${cursor}
      ORDER BY occurred_at, message_id::bigint LIMIT 100`;
    let open: OpenChunkState | null =
      state.openLastAt && state.openLastId
        ? {
            chatId,
            parts: state.openParts,
            ids: new Set(state.openIds),
            charCount: state.openParts.reduce((sum, part) => sum + Buffer.byteLength(part) + 1, 0),
            lastAt: state.openLastAt.getTime(),
            lastId: BigInt(state.openLastId),
          }
        : null;
    const finalized: Chunk[] = [];

    for (const row of rows) {
      const result = this.chunker.append(open, mapMessage(row));

      open = result.state;
      finalized.push(...result.finalized);
    }

    if (open && Date.now() - open.lastAt >= 1800000) {
      finalized.push(...this.chunker.finalize(open));
      open = null;
    }

    if (!rows.length && !finalized.length) return false;

    const vectors: number[][] = [];

    for (let offset = 0; offset < finalized.length; offset += 32)
      vectors.push(
        ...(await this.embeddings.embedDocuments(
          finalized.slice(offset, offset + 32).map((chunk) => chunk.content),
        )),
      );

    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT chat_id FROM allowed_chats WHERE chat_id = ${chatId} FOR UPDATE`;

      const active = await tx.allowedChat.findUnique({ where: { chatId } });

      if (!active?.enabled || active.mode === 'OFF') return;

      const current = await tx.indexingState.findUniqueOrThrow({ where: { chatId } });

      if (current.version !== state.version) throw new Error('Concurrent indexing');

      for (let offset = 0; offset < finalized.length; offset += 32)
        await this.vectors.upsertChunks(
          chatId,
          finalized.slice(offset, offset + 32),
          vectors.slice(offset, offset + 32),
          tx,
        );

      const last = rows.at(-1);

      await tx.indexingState.update({
        where: { chatId },
        data: {
          version: { increment: 1 },
          ...(last ? { lastOccurredAt: last.occurredAt, lastMessageId: last.messageId } : {}),
          openParts: open?.parts ?? [],
          openIds: [...(open?.ids ?? [])],
          openLastAt: open ? new Date(open.lastAt) : null,
          openLastId: open ? String(open.lastId) : null,
          updatedAt: new Date(),
        },
      });
    });

    return rows.length === 100;
  }
}

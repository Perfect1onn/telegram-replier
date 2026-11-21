import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Chunk } from '../../application/conversation-chunker.ts';
import type { RetrievedChunk } from '../../domain/types.ts';

interface VectorRow {
  id: string;
  chat_id: string;
  content: string;
  message_ids: string[];
  score: number;
}

function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== 1536 || vector.some((value) => !Number.isFinite(value)))
    throw new Error('Invalid vector');

  return `[${vector.join(',')}]`;
}

export class PgVectorRepository {
  private db: PrismaClient;
  private model: string;

  constructor(db: PrismaClient, model: string) {
    if (!model.trim()) throw new Error('Embedding model required');

    this.db = db;
    this.model = model;
  }

  async upsertChunks(
    chatId: string,
    chunks: readonly Chunk[],
    vectors: readonly number[][],
    db: PrismaClient | Prisma.TransactionClient = this.db,
  ): Promise<void> {
    if (
      chunks.length !== vectors.length ||
      chunks.length > 32 ||
      chunks.some((chunk) => chunk.chatId !== chatId || !chunk.messageIds.length)
    )
      throw new Error('Invalid chunk batch');

    if (!chunks.length) return;

    const values = chunks.map(
      (chunk, index) => Prisma.sql`(
      ${randomUUID()}::uuid, ${chatId}, ${chunk.content},
      ${chunk.messageIds[0]}, ${chunk.messageIds.at(-1)},
      ${chunk.messageIds}::text[], 'FINALIZED', ${chunk.tokenCount},
      ${this.model}, ${vectorLiteral(vectors[index] ?? [])}::vector, ${chunk.id}
    )`,
    );

    await db.$executeRaw`INSERT INTO conversation_chunks (
      id, chat_id, content, first_message_id, last_message_id, message_ids,
      status, token_count, embedding_model, embedding, content_hash
    ) VALUES ${Prisma.join(values)}
    ON CONFLICT (chat_id, content_hash, embedding_model) DO UPDATE SET
      content = EXCLUDED.content,
      message_ids = EXCLUDED.message_ids,
      token_count = EXCLUDED.token_count,
      embedding = EXCLUDED.embedding,
      status = 'FINALIZED',
      updated_at = now()`;
  }

  async search(vector: readonly number[], limit: number): Promise<RetrievedChunk[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new Error('Invalid search limit');

    const rows = await this.db.$queryRaw<VectorRow[]>`
      SELECT id::text, chat_id, content, message_ids,
        1 - (embedding <=> ${vectorLiteral(vector)}::vector) AS score
      FROM conversation_chunks
      WHERE status = 'FINALIZED'
        AND embedding_model = ${this.model} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorLiteral(vector)}::vector
      LIMIT ${limit}`;

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      content: row.content,
      messageIds: row.message_ids,
      score: row.score,
    }));
  }

  async searchLexical(query: string, limit: number): Promise<RetrievedChunk[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new Error('Invalid search limit');

    const ignored = new Set([
      'какой',
      'какая',
      'какие',
      'такой',
      'такая',
      'зовут',
      'скажи',
      'расскажи',
      'about',
      'what',
      'where',
      'which',
      'please',
    ]);
    const terms = (query.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])
      .filter((term) => !ignored.has(term))
      .slice(0, 5);

    if (!terms.length) return [];

    const tsQuery = terms.join(' | ');
    const rows = await this.db.$queryRaw<VectorRow[]>`
      SELECT c.id::text, c.chat_id, c.content, c.message_ids,
        ts_rank_cd(to_tsvector('russian', c.content), to_tsquery('russian', ${tsQuery})) AS score
      FROM conversation_chunks c
      JOIN allowed_chats a ON a.chat_id = c.chat_id
      WHERE c.status = 'FINALIZED' AND c.embedding_model = ${this.model}
        AND a.enabled AND a.mode <> 'OFF'
        AND to_tsvector('russian', c.content) @@ to_tsquery('russian', ${tsQuery})
      ORDER BY score DESC, c.updated_at DESC
      LIMIT ${limit}`;

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      content: row.content,
      messageIds: row.message_ids,
      score: row.score,
    }));
  }

  async searchOwner(
    vector: readonly number[],
    limit: number,
    since: Date,
  ): Promise<RetrievedChunk[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10 || !Number.isFinite(since.getTime()))
      throw new Error('Invalid owner search');

    const rows = await this.db.$queryRaw<VectorRow[]>`
      SELECT c.id::text, c.chat_id, c.content, c.message_ids,
        1 - (c.embedding <=> ${vectorLiteral(vector)}::vector) AS score
      FROM conversation_chunks c
      WHERE c.status = 'FINALIZED' AND c.embedding_model = ${this.model}
        AND c.embedding IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m.chat_id = c.chat_id AND m.message_id = ANY(c.message_ids)
            AND m.direction = 'OUTGOING' AND m.source = 'TELEGRAM'
            AND m.occurred_at >= ${since}
        )
      ORDER BY c.embedding <=> ${vectorLiteral(vector)}::vector
      LIMIT ${limit}`;

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      content: row.content,
      messageIds: row.message_ids,
      score: row.score,
    }));
  }
}

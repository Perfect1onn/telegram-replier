import { createHash } from 'node:crypto';
import type { ChatMessage } from '../domain/types.ts';

export interface Chunk {
  id: string;
  chatId: string;
  content: string;
  messageIds: string[];
  tokenCount: number;
}

export interface OpenChunkState {
  chatId: string;
  parts: string[];
  ids: Set<string>;
  charCount: number;
  lastAt: number;
  lastId: bigint;
}

export class ConversationChunker {
  private maxChars: number;
  private gapMs: number;

  constructor(maxTokens = 700, gapMs = 1800000) {
    if (!Number.isInteger(maxTokens) || maxTokens < 32) throw new Error('Invalid chunk limit');

    this.maxChars = maxTokens;
    this.gapMs = gapMs;
  }

  append(
    state: OpenChunkState | null,
    message: ChatMessage,
  ): { state: OpenChunkState; finalized: Chunk[] } {
    if (state && state.chatId !== message.chatId) throw new Error('Cross-chat chunk');

    if (state?.ids.has(message.messageId)) return { state, finalized: [] };

    const time = message.occurredAt.getTime();
    const id = BigInt(message.messageId);

    if (
      !Number.isFinite(time) ||
      (state && (time < state.lastAt || (time === state.lastAt && id < state.lastId)))
    )
      throw new Error('Non-monotonic message');

    const finalized: Chunk[] = [];
    let open = state;
    const fields = {
      id: message.messageId,
      at: message.occurredAt.toISOString(),
      speaker: message.senderId,
      replyTo: message.replyToMessageId,
    };
    const line = JSON.stringify({ ...fields, text: message.text });
    const lines =
      Buffer.byteLength(line) <= this.maxChars ? [line] : this.segment(fields, message.text);

    for (const part of lines) {
      const partBytes = Buffer.byteLength(part);

      if (
        open &&
        (open.charCount + partBytes + 1 > this.maxChars ||
          time - open.lastAt > this.gapMs ||
          lines.length > 1)
      ) {
        finalized.push(...this.finalize(open));
        open = null;
      }

      open ??= {
        chatId: message.chatId,
        parts: [],
        ids: new Set(),
        charCount: 0,
        lastAt: time,
        lastId: id,
      };
      open.parts.push(part);
      open.ids.add(message.messageId);
      open.charCount += partBytes + 1;
      open.lastAt = time;
      open.lastId = id;
    }

    if (!open) throw new Error('No open chunk');

    return { state: open, finalized };
  }

  private segment(
    fields: { id: string; at: string; speaker: string; replyTo: string | undefined },
    text: string,
  ): string[] {
    const overhead = Buffer.byteLength(JSON.stringify({ ...fields, part: 999999, text: '' }));

    if (overhead >= this.maxChars) throw new Error('Chunk limit too small for metadata');

    const lines: string[] = [];
    let piece: string[] = [];
    let size = overhead;

    for (const character of text) {
      const bytes = Buffer.byteLength(JSON.stringify(character)) - 2;

      if (size + bytes > this.maxChars) {
        lines.push(JSON.stringify({ ...fields, part: lines.length, text: piece.join('') }));
        piece = [];
        size = overhead;
      }

      if (size + bytes > this.maxChars) throw new Error('Chunk limit too small for character');

      piece.push(character);
      size += bytes;
    }

    if (piece.length)
      lines.push(JSON.stringify({ ...fields, part: lines.length, text: piece.join('') }));

    return lines;
  }

  finalize(state: OpenChunkState): Chunk[] {
    if (!state.parts.length) return [];

    const content = state.parts.join('\n');

    return [
      {
        id: createHash('sha256')
          .update(state.chatId + '\0' + content)
          .digest('hex'),
        chatId: state.chatId,
        content,
        messageIds: [...state.ids],
        tokenCount: Buffer.byteLength(content),
      },
    ];
  }
}

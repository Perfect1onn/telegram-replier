import type { AllowedChat, Message, ReplyOperation as PrismaOperation } from '@prisma/client';
import type { ChatConfig, ChatMessage, ReplyOperation } from '../../domain/types.ts';

export function mapChat(row: AllowedChat): ChatConfig {
  if (!['OFF', 'DRAFT', 'AUTO'].includes(row.mode)) throw new Error('Invalid stored mode');

  const mode = row.mode === 'AUTO' ? 'AUTO' : row.mode === 'DRAFT' ? 'DRAFT' : 'OFF';

  return {
    chatId: row.chatId,
    enabled: row.enabled,
    mode,
    version: row.version,
    replyDelayMs: row.replyDelayMs,
    recentMessageLimit: row.recentMessageLimit,
    cancelOnManualReply: row.cancelOnManualReply,
    maxRepliesPerHour: row.maxRepliesPerHour,
    ...(row.systemPrompt === null ? {} : { systemPrompt: row.systemPrompt }),
  };
}

export function mapMessage(row: Message): ChatMessage {
  if (row.direction !== 'INCOMING' && row.direction !== 'OUTGOING')
    throw new Error('Invalid direction');

  if (row.source !== 'TELEGRAM' && row.source !== 'AI') throw new Error('Invalid source');

  return {
    chatId: row.chatId,
    messageId: row.messageId,
    senderId: row.senderId,
    direction: row.direction,
    source: row.source,
    text: row.text,
    occurredAt: row.occurredAt,
    ...(row.replyToMessageId === null ? {} : { replyToMessageId: row.replyToMessageId }),
    ...(row.editedAt === null ? {} : { editedAt: row.editedAt }),
  };
}

export function mapOperation(row: PrismaOperation): ReplyOperation {
  const generation = Number(row.generation);

  if (!Number.isSafeInteger(generation)) throw new Error('Generation overflow');

  const status = row.status;

  if (
    status !== 'PENDING' &&
    status !== 'DRAFT' &&
    status !== 'SENDING' &&
    status !== 'SENT' &&
    status !== 'UNKNOWN' &&
    status !== 'CANCELLED' &&
    status !== 'REJECTED'
  )
    throw new Error('Invalid operation status');

  return {
    id: row.id,
    chatId: row.chatId,
    generation,
    configVersion: row.configVersion,
    triggerMessageId: row.triggerMessageId,
    dueAt: row.dueAt.getTime(),
    status,
    ...(row.telegramMessageId === null ? {} : { telegramMessageId: row.telegramMessageId }),
  };
}

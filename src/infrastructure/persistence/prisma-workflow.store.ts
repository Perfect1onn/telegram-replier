import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type {
  Answer,
  AuditEvent,
  ChatMessage,
  ReplyInput,
  ReplyOperation,
  SyncStatus,
  UsagePricing,
} from '../../domain/types.ts';
import { AccessDeniedError, ConflictError } from '../../domain/types.ts';
import type { IWorkflowStore } from '../../ports/contracts.ts';
import { mapChat, mapMessage, mapOperation } from './message.mapper.ts';
import { validateChatPatch, type ChatPatch } from '../../application/chat-config.ts';
import { defaultChat, type ChatConfig } from '../../domain/types.ts';
import { estimateCost } from '../../application/ai.service.ts';

export class PrismaWorkflowStore implements IWorkflowStore {
  private db: PrismaClient;

  constructor(db: PrismaClient) {
    this.db = db;
  }

  async getChat(chatId: string) {
    const chat = await this.db.allowedChat.findUnique({ where: { chatId } });

    return chat ? mapChat(chat) : null;
  }

  async updateChat(chatId: string, patch: ChatPatch, expectedVersion: number): Promise<ChatConfig> {
    if (!/^[1-9]\d*$/.test(chatId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
      throw new Error('Invalid chat identifier or version');

    validateChatPatch(patch);

    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM system_state WHERE id = 1 FOR UPDATE`;
      await tx.$queryRaw`SELECT chat_id FROM allowed_chats WHERE chat_id = ${chatId} FOR UPDATE`;

      const current = await tx.allowedChat.findUnique({ where: { chatId } });

      if ((current?.version ?? 0) !== expectedVersion) throw new ConflictError();

      const unresolved = await tx.replyOperation.count({
        where: { chatId, status: { in: ['SENDING', 'UNKNOWN'] } },
      });

      if (unresolved) throw new ConflictError('Send outcome unresolved');

      const data = {
        ...patch,
        version: expectedVersion + 1,
        updatedAt: new Date(),
      };
      const row = current
        ? await tx.allowedChat.update({ where: { chatId }, data })
        : await tx.allowedChat.create({
            data: { ...defaultChat(chatId), enabled: false, ...data },
          });

      await tx.chatRuntimeState.upsert({
        where: { chatId },
        create: { chatId, generation: 1 },
        update: { generation: { increment: 1 }, updatedAt: new Date() },
      });
      await tx.draft.updateMany({
        where: { chatId, status: 'PENDING' },
        data: { status: 'EXPIRED', updatedAt: new Date() },
      });

      return mapChat(row);
    });
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM system_state WHERE id = 1 FOR UPDATE`;

      if (!paused) {
        const unresolved = await tx.replyOperation.count({ where: { status: 'SENDING' } });

        if (unresolved) throw new ConflictError('Send outcome unresolved');
      }

      await tx.systemState.update({ where: { id: 1 }, data: { paused, updatedAt: new Date() } });
    });
  }

  async recoverInterruptedSends(): Promise<number> {
    const result = await this.db.replyOperation.updateMany({
      where: { status: 'SENDING' },
      data: { status: 'UNKNOWN', errorCategory: 'PROCESS_INTERRUPTED', updatedAt: new Date() },
    });

    return result.count;
  }

  async reserveUsage(
    chatId: string,
    model: string,
    maxInputTokens: number,
    pricing: UsagePricing,
  ): Promise<string | null> {
    if (
      !Number.isSafeInteger(maxInputTokens) ||
      maxInputTokens < 1 ||
      maxInputTokens > 200000 ||
      !Number.isFinite(pricing.dailyBudgetUsd) ||
      pricing.dailyBudgetUsd <= 0
    )
      return null;

    const reservedCost = estimateCost(
      { inputTokens: maxInputTokens, outputTokens: 1024, cachedInputTokens: 0 },
      pricing.prices,
    );
    const now = new Date();
    const dayStart = new Date(now);

    dayStart.setUTCHours(0, 0, 0, 0);

    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM system_state WHERE id = 1 FOR UPDATE`;

      const system = await tx.systemState.findUnique({ where: { id: 1 } });

      if (!system || system.paused) return null;

      const chat = await tx.allowedChat.findUnique({ where: { chatId } });

      if (!chat?.enabled || chat.mode === 'OFF') return null;

      const aggregate = await tx.llmUsage.aggregate({
        where: {
          createdAt: { gte: dayStart },
          status: { in: ['RESERVED', 'COMPLETED', 'UNKNOWN'] },
        },
        _sum: { estimatedCostUsd: true },
      });
      const spent = aggregate._sum.estimatedCostUsd?.toNumber() ?? 0;

      if (spent + reservedCost > pricing.dailyBudgetUsd) return null;

      const id = randomUUID();

      await tx.llmUsage.create({
        data: {
          requestId: id,
          chatId,
          model,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          estimatedCostUsd: reservedCost,
          priceVersion: pricing.version,
          priceEffectiveAt: pricing.effectiveAt,
          status: 'RESERVED',
          createdAt: now,
        },
      });

      return id;
    });
  }

  async completeUsage(id: string, answer: Answer, pricing: UsagePricing): Promise<void> {
    const cost = estimateCost(answer.usage, pricing.prices);
    const updated = await this.db.llmUsage.updateMany({
      where: { requestId: id, status: 'RESERVED' },
      data: {
        model: answer.model,
        inputTokens: answer.usage.inputTokens,
        outputTokens: answer.usage.outputTokens,
        cachedInputTokens: answer.usage.cachedInputTokens,
        estimatedCostUsd: cost,
        status: 'COMPLETED',
      },
    });

    if (!updated.count) throw new ConflictError('Usage reservation missing');
  }

  async unknownUsage(id: string): Promise<void> {
    await this.db.llmUsage.updateMany({
      where: { requestId: id, status: 'RESERVED' },
      data: { status: 'UNKNOWN' },
    });
  }

  async rejectDraft(id: string): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const draft = await tx.draft.findUnique({ where: { id } });

      if (!draft || draft.status !== 'PENDING') return false;

      await tx.$queryRaw`SELECT id FROM system_state WHERE id = 1 FOR UPDATE`;
      await tx.$queryRaw`SELECT chat_id FROM allowed_chats WHERE chat_id = ${draft.chatId} FOR UPDATE`;

      const updated = await tx.draft.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'REJECTED', updatedAt: new Date() },
      });

      if (!updated.count) return false;

      await tx.replyOperation.updateMany({
        where: { id, status: 'DRAFT' },
        data: { status: 'REJECTED', updatedAt: new Date() },
      });

      return true;
    });
  }

  async purgeChat(chatId: string): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM system_state WHERE id = 1 FOR UPDATE`;
      await tx.$queryRaw`SELECT chat_id FROM allowed_chats WHERE chat_id = ${chatId} FOR UPDATE`;

      const chat = await tx.allowedChat.findUnique({ where: { chatId } });

      if (!chat) return false;

      if (await tx.replyOperation.count({ where: { chatId, status: 'SENDING' } }))
        throw new ConflictError('Send in flight');

      await tx.deferredOutgoing.deleteMany({ where: { chatId } });
      await tx.draft.deleteMany({ where: { chatId } });
      await tx.replyOperation.deleteMany({ where: { chatId } });
      await tx.jobOutbox.deleteMany({ where: { chatId } });
      await tx.conversationChunk.deleteMany({ where: { chatId } });
      await tx.indexingState.deleteMany({ where: { chatId } });
      await tx.syncCheckpoint.deleteMany({ where: { chatId } });
      await tx.llmUsage.deleteMany({ where: { chatId } });
      await tx.message.deleteMany({ where: { chatId } });
      await tx.chatRuntimeState.deleteMany({ where: { chatId } });
      await tx.auditEvent.deleteMany({ where: { chatId } });
      await tx.allowedChat.delete({ where: { chatId } });

      return true;
    });
  }

  async enqueueBackfill(chatId: string): Promise<string> {
    return this.db.$transaction(async (tx) => {
      await this.lockChat(tx, chatId);

      const id = randomUUID();
      const generation = BigInt(`0x${randomBytes(7).toString('hex')}`);

      await tx.jobOutbox.create({
        data: {
          id,
          chatId,
          generation,
          taskType: 'backfill',
          payload: { chatId },
          dueAt: new Date(),
        },
      });

      return id;
    });
  }

  async enqueueCatchUp(chatId: string): Promise<string | null> {
    return this.db.$transaction(async (tx) => {
      await this.lockChat(tx, chatId);

      const state = await tx.chatRuntimeState.findUnique({ where: { chatId } });

      if (!state?.lastTelegramMessageId) return null;

      const id = randomUUID();
      const generation = BigInt(`0x${randomBytes(7).toString('hex')}`);

      await tx.jobOutbox.create({
        data: {
          id,
          chatId,
          generation,
          taskType: 'catchup',
          payload: { chatId, baselineId: state.lastTelegramMessageId },
          dueAt: new Date(),
        },
      });

      return id;
    });
  }

  async reconcileSend(
    id: string,
    outcome: 'SENT' | 'NOT_SENT',
    messageId?: string,
  ): Promise<boolean> {
    if (outcome === 'SENT' && (!messageId || !/^\d+$/.test(messageId)))
      throw new Error('Telegram message ID required');

    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM system_state WHERE id = 1 FOR UPDATE`;

      const operation = await tx.replyOperation.findUnique({ where: { id } });

      if (!operation || operation.status !== 'UNKNOWN') return false;

      await tx.$queryRaw`SELECT chat_id FROM allowed_chats WHERE chat_id = ${operation.chatId} FOR UPDATE`;

      const deferred = await tx.deferredOutgoing.findMany({ where: { chatId: operation.chatId } });
      const manual = deferred.some(
        (item) => outcome === 'NOT_SENT' || item.messageId !== messageId,
      );

      await tx.replyOperation.update({
        where: { id },
        data: {
          status: outcome === 'SENT' ? 'SENT' : 'CANCELLED',
          telegramMessageId: outcome === 'SENT' ? (messageId ?? null) : null,
          errorCategory: outcome === 'SENT' ? null : 'ADMIN_CONFIRMED_NOT_SENT',
          updatedAt: new Date(),
        },
      });

      if (outcome === 'SENT' && messageId)
        await tx.message.upsert({
          where: { chatId_messageId: { chatId: operation.chatId, messageId } },
          create: {
            chatId: operation.chatId,
            messageId,
            senderId: 'self',
            direction: 'OUTGOING',
            source: 'AI',
            text: operation.generatedText ?? '',
            occurredAt: new Date(),
          },
          update: { source: 'AI' },
        });

      await tx.deferredOutgoing.deleteMany({ where: { chatId: operation.chatId } });

      if (manual) {
        await tx.chatRuntimeState.update({
          where: { chatId: operation.chatId },
          data: { generation: { increment: 1 }, updatedAt: new Date() },
        });
        await tx.draft.updateMany({
          where: { chatId: operation.chatId, status: 'PENDING' },
          data: { status: 'EXPIRED', updatedAt: new Date() },
        });
      }

      await tx.auditEvent.create({
        data: {
          actor: 'admin',
          action: 'reconcile_send',
          chatId: operation.chatId,
          outcome,
          reason: 'explicit_admin_decision',
          correlationId: randomUUID(),
        },
      });

      return true;
    });
  }

  private async lockChat(tx: Prisma.TransactionClient, chatId: string) {
    await tx.$queryRaw`SELECT chat_id FROM allowed_chats WHERE chat_id = ${chatId} FOR UPDATE`;

    const chat = await tx.allowedChat.findUnique({ where: { chatId } });

    if (!chat?.enabled || chat.mode === 'OFF') throw new AccessDeniedError();

    return chat;
  }

  async ingest(message: ChatMessage, now: number): Promise<void> {
    if (!/^[1-9]\d*$/.test(message.messageId)) throw new Error('Invalid message identifier');

    await this.db.$transaction(async (tx) => {
      const chat = await this.lockChat(tx, message.chatId);
      const inserted = await tx.message.createMany({ data: [message], skipDuplicates: true });

      if (!inserted.count) {
        if (!message.editedAt || !Number.isFinite(message.editedAt.getTime())) return;

        const existing = await tx.message.findUnique({
          where: { chatId_messageId: { chatId: message.chatId, messageId: message.messageId } },
        });

        if (!existing || (existing.editedAt && existing.editedAt >= message.editedAt)) return;

        if (existing.text === message.text) {
          await tx.message.update({
            where: { chatId_messageId: { chatId: message.chatId, messageId: message.messageId } },
            data: { editedAt: message.editedAt },
          });

          return;
        }

        await tx.message.update({
          where: { chatId_messageId: { chatId: message.chatId, messageId: message.messageId } },
          data: { text: message.text, editedAt: message.editedAt },
        });
        await tx.chatRuntimeState.upsert({
          where: { chatId: message.chatId },
          create: { chatId: message.chatId, generation: 1 },
          update: { generation: { increment: 1 }, updatedAt: new Date(now) },
        });
        await tx.draft.updateMany({
          where: { chatId: message.chatId, status: 'PENDING' },
          data: { status: 'EXPIRED', updatedAt: new Date(now) },
        });
        await tx.replyOperation.updateMany({
          where: { chatId: message.chatId, status: { in: ['PENDING', 'DRAFT'] } },
          data: { status: 'CANCELLED', updatedAt: new Date(now) },
        });
        await tx.conversationChunk.deleteMany({ where: { chatId: message.chatId } });
        await tx.indexingState.deleteMany({ where: { chatId: message.chatId } });
        await tx.jobOutbox.create({
          data: {
            id: randomUUID(),
            chatId: message.chatId,
            generation: BigInt(`0x${randomBytes(7).toString('hex')}`),
            taskType: 'indexing',
            payload: { chatId: message.chatId },
            dueAt: new Date(now),
          },
        });

        return;
      }

      const previous = await tx.chatRuntimeState.findUnique({ where: { chatId: message.chatId } });

      if (
        !previous?.lastTelegramMessageId ||
        BigInt(message.messageId) > BigInt(previous.lastTelegramMessageId)
      )
        await tx.chatRuntimeState.upsert({
          where: { chatId: message.chatId },
          create: { chatId: message.chatId, lastTelegramMessageId: message.messageId },
          update: { lastTelegramMessageId: message.messageId, updatedAt: new Date(now) },
        });

      const ai =
        message.direction === 'OUTGOING' &&
        (await tx.replyOperation.findFirst({
          where: { chatId: message.chatId, telegramMessageId: message.messageId, status: 'SENT' },
          select: { id: true },
        }));

      if (ai || message.source === 'AI') return;

      if (message.direction === 'OUTGOING') {
        const sending = await tx.replyOperation.findFirst({
          where: { chatId: message.chatId, status: 'SENDING' },
          select: { id: true },
        });

        if (sending) {
          await tx.deferredOutgoing.create({
            data: {
              chatId: message.chatId,
              messageId: message.messageId,
              occurredAt: message.occurredAt,
            },
          });

          return;
        }
      }

      if (message.direction === 'OUTGOING' && !chat.cancelOnManualReply) return;

      const state = await tx.chatRuntimeState.upsert({
        where: { chatId: message.chatId },
        create: {
          chatId: message.chatId,
          generation: 1,
          ...(message.direction === 'OUTGOING' ? { lastManualOutgoingAt: message.occurredAt } : {}),
        },
        update: {
          generation: { increment: 1 },
          updatedAt: new Date(now),
          ...(message.direction === 'OUTGOING' ? { lastManualOutgoingAt: message.occurredAt } : {}),
        },
      });

      await tx.draft.updateMany({
        where: { chatId: message.chatId, status: 'PENDING' },
        data: { status: 'EXPIRED', updatedAt: new Date(now) },
      });

      if (message.direction === 'OUTGOING') return;

      const generation = Number(state.generation);

      if (!Number.isSafeInteger(generation)) throw new Error('Generation overflow');

      const dueAt = new Date(now + chat.replyDelayMs);
      const input: ReplyInput = {
        chatId: message.chatId,
        generation,
        configVersion: chat.version,
        triggerMessageId: message.messageId,
      };

      await tx.replyOperation.create({
        data: {
          id: randomUUID(),
          ...input,
          status: 'PENDING',
          dueAt,
          dedupeKey: `${message.chatId}:${generation}`,
        },
      });
      await tx.jobOutbox.createMany({
        data: [
          {
            id: randomUUID(),
            chatId: message.chatId,
            generation,
            taskType: 'reply',
            payload: { ...input },
            dueAt,
          },
          {
            id: randomUUID(),
            chatId: message.chatId,
            generation,
            taskType: 'indexing',
            payload: { chatId: message.chatId },
            dueAt: new Date(now),
          },
        ],
      });
    });
  }

  async getRecent(chatId: string, limit: number): Promise<ChatMessage[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid limit');

    return (
      await this.db.message.findMany({
        where: { chatId },
        orderBy: [{ occurredAt: 'desc' }, { messageId: 'desc' }],
        take: limit,
      })
    )
      .reverse()
      .map(mapMessage);
  }

  async getByIds(chatId: string, ids: readonly string[]): Promise<ChatMessage[]> {
    if (ids.length > 100) throw new Error('Batch too large');

    return (await this.db.message.findMany({ where: { chatId, messageId: { in: [...ids] } } })).map(
      mapMessage,
    );
  }

  async current(input: ReplyInput): Promise<boolean> {
    const [chat, state, operation] = await Promise.all([
      this.db.allowedChat.findUnique({ where: { chatId: input.chatId } }),
      this.db.chatRuntimeState.findUnique({ where: { chatId: input.chatId } }),
      this.db.replyOperation.findUnique({
        where: { chatId_generation: { chatId: input.chatId, generation: input.generation } },
      }),
    ]);

    return Boolean(
      chat?.enabled &&
      chat.mode !== 'OFF' &&
      chat.version === input.configVersion &&
      state?.generation === BigInt(input.generation) &&
      operation &&
      ['PENDING', 'DRAFT'].includes(operation.status),
    );
  }

  async saveDraft(input: ReplyInput, answer: Answer): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const chat = await this.lockChat(tx, input.chatId);
      const state = await tx.chatRuntimeState.findUnique({ where: { chatId: input.chatId } });

      if (chat.version !== input.configVersion || state?.generation !== BigInt(input.generation))
        return;

      const operation = await tx.replyOperation.findUnique({
        where: { chatId_generation: { chatId: input.chatId, generation: input.generation } },
      });

      if (!operation || operation.status !== 'PENDING') return;

      await tx.replyOperation.update({
        where: { id: operation.id },
        data: { status: 'DRAFT', generatedText: answer.text },
      });
      await tx.draft.create({ data: { id: operation.id, ...input, text: answer.text } });
    });
  }

  async claimSend(
    input: ReplyInput,
    answer: Answer,
    approved: boolean,
    now: number,
  ): Promise<ReplyOperation | null> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM system_state WHERE id = 1 FOR UPDATE`;

      const system = await tx.systemState.findUnique({ where: { id: 1 } });

      if (!system || system.paused) return null;

      const chat = await this.lockChat(tx, input.chatId);

      if (
        chat.version !== input.configVersion ||
        (chat.mode !== 'AUTO' && !(approved && chat.mode === 'DRAFT'))
      )
        return null;

      const state = await tx.chatRuntimeState.findUnique({ where: { chatId: input.chatId } });

      if (state?.generation !== BigInt(input.generation)) return null;

      const unresolved = await tx.replyOperation.count({
        where: { chatId: input.chatId, status: { in: ['SENDING', 'UNKNOWN'] } },
      });

      if (unresolved) return null;

      const sent = await tx.replyOperation.count({
        where: {
          chatId: input.chatId,
          status: 'SENT',
          updatedAt: { gte: new Date(now - 3600000) },
        },
      });

      if (sent >= chat.maxRepliesPerHour) return null;

      const operation = await tx.replyOperation.findUnique({
        where: { chatId_generation: { chatId: input.chatId, generation: input.generation } },
      });

      if (
        !operation ||
        !(operation.status === 'PENDING' || (approved && operation.status === 'DRAFT'))
      )
        return null;

      if (approved) {
        const draft = await tx.draft.findFirst({
          where: { id: operation.id, chatId: input.chatId, status: 'PENDING', text: answer.text },
        });

        if (!draft) return null;

        await tx.draft.update({
          where: { id: draft.id },
          data: { status: 'APPROVED', updatedAt: new Date(now) },
        });
      }

      return mapOperation(
        await tx.replyOperation.update({
          where: { id: operation.id },
          data: {
            status: 'SENDING',
            generatedText: answer.text,
            attempts: { increment: 1 },
            updatedAt: new Date(now),
          },
        }),
      );
    });
  }

  async finishSend(id: string, result: { messageId: string } | null): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const operation = await tx.replyOperation.findUnique({ where: { id } });

      if (!operation || operation.status !== 'SENDING') throw new ConflictError();

      await tx.$queryRaw`SELECT chat_id FROM allowed_chats WHERE chat_id = ${operation.chatId} FOR UPDATE`;

      await tx.replyOperation.update({
        where: { id },
        data: {
          status: result ? 'SENT' : 'UNKNOWN',
          telegramMessageId: result?.messageId ?? null,
          updatedAt: new Date(),
        },
      });

      if (result)
        await tx.message.upsert({
          where: { chatId_messageId: { chatId: operation.chatId, messageId: result.messageId } },
          create: {
            chatId: operation.chatId,
            messageId: result.messageId,
            senderId: 'self',
            direction: 'OUTGOING',
            source: 'AI',
            text: operation.generatedText ?? '',
            occurredAt: new Date(),
          },
          update: { source: 'AI' },
        });

      if (result) {
        const deferred = await tx.deferredOutgoing.findMany({
          where: { chatId: operation.chatId },
        });
        const manual = deferred.some((item) => item.messageId !== result.messageId);

        await tx.deferredOutgoing.deleteMany({ where: { chatId: operation.chatId } });

        if (manual) {
          await tx.chatRuntimeState.update({
            where: { chatId: operation.chatId },
            data: { generation: { increment: 1 }, updatedAt: new Date() },
          });
          await tx.draft.updateMany({
            where: { chatId: operation.chatId, status: 'PENDING' },
            data: { status: 'EXPIRED', updatedAt: new Date() },
          });
        }
      }
    });
  }

  async audit(event: AuditEvent): Promise<void> {
    await this.db.auditEvent.create({
      data: {
        actor: 'system',
        action: event.action,
        chatId: event.chatId,
        reason: event.reason,
        outcome: 'recorded',
        correlationId: randomUUID(),
        createdAt: event.at,
      },
    });
  }

  async lastKnownMessageId(chatId: string): Promise<string | null> {
    const state = await this.db.chatRuntimeState.findUnique({ where: { chatId } });

    return state?.lastTelegramMessageId ?? null;
  }

  async checkpoint(chatId: string, kind: 'BACKFILL' | 'CATCHUP' = 'BACKFILL'): Promise<SyncStatus> {
    const row = await this.db.syncCheckpoint.findUnique({
      where: { chatId_kind: { chatId, kind } },
    });

    return { complete: row?.state === 'COMPLETE', ...(row?.cursor ? { cursor: row.cursor } : {}) };
  }

  async saveHistory(
    chatId: string,
    messages: ChatMessage[],
    checkpoint: SyncStatus,
    kind: 'BACKFILL' | 'CATCHUP' = 'BACKFILL',
  ): Promise<void> {
    if (
      messages.length > 100 ||
      messages.some((message) => message.chatId !== chatId || !/^[1-9]\d*$/.test(message.messageId))
    )
      throw new AccessDeniedError();

    await this.db.$transaction(async (tx) => {
      await this.lockChat(tx, chatId);
      await tx.message.createMany({ data: messages, skipDuplicates: true });

      const data = {
        cursor: checkpoint.cursor ?? null,
        state: checkpoint.complete ? 'COMPLETE' : 'PENDING',
        lastSuccessAt: new Date(),
        updatedAt: new Date(),
      };

      await tx.syncCheckpoint.upsert({
        where: { chatId_kind: { chatId, kind } },
        create: { chatId, kind, ...data },
        update: data,
      });

      if (checkpoint.complete) {
        const [result] = await tx.$queryRaw<Array<{ max_id: bigint | null }>>`
          SELECT MAX(message_id::bigint) AS max_id FROM messages
          WHERE chat_id = ${chatId} AND message_id ~ '^[0-9]+$'`;
        const state = await tx.chatRuntimeState.findUnique({ where: { chatId } });

        if (
          result?.max_id &&
          (!state?.lastTelegramMessageId || result.max_id > BigInt(state.lastTelegramMessageId))
        )
          await tx.chatRuntimeState.upsert({
            where: { chatId },
            create: { chatId, lastTelegramMessageId: String(result.max_id) },
            update: { lastTelegramMessageId: String(result.max_id), updatedAt: new Date() },
          });
      }
    });
  }
}

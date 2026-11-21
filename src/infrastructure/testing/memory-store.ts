import type {
  Answer,
  AuditEvent,
  ChatConfig,
  ChatMessage,
  ReplyInput,
  ReplyOperation,
  SyncStatus,
  UsagePricing,
} from '../../domain/types.ts';
import { ConflictError } from '../../domain/types.ts';
import type { IWorkflowStore } from '../../ports/contracts.ts';
import { validateChatPatch, type ChatPatch } from '../../application/chat-config.ts';
import { defaultChat } from '../../domain/types.ts';

export class MemoryStore implements IWorkflowStore {
  chats = new Map<string, ChatConfig>();
  messages = new Map<string, Map<string, ChatMessage>>();
  generations = new Map<string, number>();
  operations = new Map<string, ReplyOperation>();
  checkpoints = new Map<string, SyncStatus>();
  audits: AuditEvent[] = [];
  paused = true;

  async getChat(chatId: string): Promise<ChatConfig | null> {
    return structuredClone(this.chats.get(chatId) ?? null);
  }

  async updateChat(chatId: string, patch: ChatPatch, expectedVersion: number): Promise<ChatConfig> {
    validateChatPatch(patch);

    const current = this.chats.get(chatId);

    if ((current?.version ?? 0) !== expectedVersion) throw new ConflictError();

    const next = {
      ...(current ?? { ...defaultChat(chatId), enabled: false, version: 0 }),
      ...patch,
    };

    this.update(next, expectedVersion);

    return structuredClone({ ...next, version: expectedVersion + 1 });
  }

  update(chat: ChatConfig, expectedVersion: number): void {
    if ((this.chats.get(chat.chatId)?.version ?? 0) !== expectedVersion) throw new ConflictError();

    if (
      [...this.operations.values()].some(
        (op) => op.chatId === chat.chatId && op.status === 'SENDING',
      )
    )
      throw new ConflictError('Send in flight');

    this.chats.set(chat.chatId, { ...chat, version: expectedVersion + 1 });
    this.generations.set(chat.chatId, (this.generations.get(chat.chatId) ?? 0) + 1);
  }

  async ingest(message: ChatMessage, now: number): Promise<void> {
    const chat = this.chats.get(message.chatId);

    if (!chat?.enabled || chat.mode === 'OFF') return;

    const messages = this.messages.get(message.chatId) ?? new Map<string, ChatMessage>();

    const existing = messages.get(message.messageId);

    if (existing) {
      if (!message.editedAt || (existing.editedAt && existing.editedAt >= message.editedAt)) return;

      messages.set(
        message.messageId,
        structuredClone({ ...existing, text: message.text, editedAt: message.editedAt }),
      );

      if (existing.text !== message.text) {
        this.generations.set(message.chatId, (this.generations.get(message.chatId) ?? 0) + 1);

        for (const operation of this.operations.values())
          if (
            operation.chatId === message.chatId &&
            ['PENDING', 'DRAFT'].includes(operation.status)
          )
            operation.status = 'CANCELLED';
      }

      return;
    }

    messages.set(message.messageId, structuredClone(message));
    this.messages.set(message.chatId, messages);

    if (message.direction === 'OUTGOING' && (!chat.cancelOnManualReply || message.source === 'AI'))
      return;

    const generation = (this.generations.get(message.chatId) ?? 0) + 1;

    this.generations.set(message.chatId, generation);

    if (message.direction === 'OUTGOING') return;

    const id = `${message.chatId}:${generation}`;

    this.operations.set(id, {
      id,
      chatId: message.chatId,
      generation,
      configVersion: chat.version,
      triggerMessageId: message.messageId,
      dueAt: now + chat.replyDelayMs,
      status: 'PENDING',
    });
  }

  async getRecent(chatId: string, limit: number): Promise<ChatMessage[]> {
    return structuredClone(
      [...(this.messages.get(chatId)?.values() ?? [])]
        .sort(
          (a, b) =>
            a.occurredAt.getTime() - b.occurredAt.getTime() ||
            (BigInt(a.messageId) < BigInt(b.messageId) ? -1 : 1),
        )
        .slice(-limit),
    );
  }

  async getByIds(chatId: string, ids: readonly string[]): Promise<ChatMessage[]> {
    const messages = this.messages.get(chatId);
    const result = [];

    for (const id of ids) {
      const message = messages?.get(id);

      if (message) result.push(structuredClone(message));
    }

    return result;
  }

  async current(input: ReplyInput): Promise<boolean> {
    const chat = this.chats.get(input.chatId);
    const operation = this.operations.get(`${input.chatId}:${input.generation}`);

    if (operation && !['PENDING', 'DRAFT'].includes(operation.status)) return false;

    return Boolean(
      chat?.enabled &&
      chat.mode !== 'OFF' &&
      chat.version === input.configVersion &&
      this.generations.get(input.chatId) === input.generation,
    );
  }

  async saveDraft(input: ReplyInput, answer: Answer): Promise<void> {
    if (!(await this.current(input))) return;

    const operation = this.operations.get(`${input.chatId}:${input.generation}`);

    if (operation?.status === 'PENDING') {
      operation.status = 'DRAFT';
      operation.answer = answer;
    }
  }

  async claimSend(
    input: ReplyInput,
    answer: Answer,
    approved: boolean,
    now: number,
  ): Promise<ReplyOperation | null> {
    const chat = this.chats.get(input.chatId);
    const operation = this.operations.get(`${input.chatId}:${input.generation}`);

    if (
      this.paused ||
      !chat?.enabled ||
      chat.version !== input.configVersion ||
      this.generations.get(input.chatId) !== input.generation
    )
      return null;

    if (chat.mode !== 'AUTO' && !(approved && chat.mode === 'DRAFT')) return null;

    if (
      !operation ||
      !(operation.status === 'PENDING' || (approved && operation.status === 'DRAFT'))
    )
      return null;

    const active = [...this.operations.values()].filter((op) => op.chatId === input.chatId);

    if (active.some((op) => op.status === 'SENDING' || op.status === 'UNKNOWN')) return null;

    if (
      active.filter((op) => op.status === 'SENT' && op.dueAt >= now - 3600000).length >=
      chat.maxRepliesPerHour
    )
      return null;

    operation.status = 'SENDING';
    operation.answer = answer;

    return structuredClone(operation);
  }

  async finishSend(id: string, result: { messageId: string } | null): Promise<void> {
    const operation = this.operations.get(id);

    if (!operation || operation.status !== 'SENDING') throw new ConflictError();

    operation.status = result ? 'SENT' : 'UNKNOWN';

    if (result) {
      operation.telegramMessageId = result.messageId;

      const messages = this.messages.get(operation.chatId) ?? new Map<string, ChatMessage>();

      messages.set(result.messageId, {
        chatId: operation.chatId,
        messageId: result.messageId,
        senderId: 'self',
        direction: 'OUTGOING',
        source: 'AI',
        text: operation.answer?.text ?? '',
        occurredAt: new Date(),
      });
      this.messages.set(operation.chatId, messages);
    }
  }

  async audit(event: AuditEvent): Promise<void> {
    this.audits.push(event);
  }

  async checkpoint(chatId: string, kind: 'BACKFILL' | 'CATCHUP' = 'BACKFILL'): Promise<SyncStatus> {
    return this.checkpoints.get(`${chatId}:${kind}`) ?? { complete: false };
  }

  async lastKnownMessageId(chatId: string): Promise<string | null> {
    const ids = [...(this.messages.get(chatId)?.keys() ?? [])];

    return ids.length ? ids.reduce((max, id) => (BigInt(id) > BigInt(max) ? id : max)) : null;
  }

  async saveHistory(
    chatId: string,
    batch: ChatMessage[],
    checkpoint: SyncStatus,
    kind: 'BACKFILL' | 'CATCHUP' = 'BACKFILL',
  ): Promise<void> {
    const chat = this.chats.get(chatId);

    if (!chat?.enabled || chat.mode === 'OFF' || batch.some((m) => m.chatId !== chatId))
      throw new ConflictError();

    const messages = this.messages.get(chatId) ?? new Map<string, ChatMessage>();

    for (const message of batch)
      if (!messages.has(message.messageId))
        messages.set(message.messageId, structuredClone(message));

    this.messages.set(chatId, messages);
    this.checkpoints.set(`${chatId}:${kind}`, checkpoint);
  }

  async reserveUsage(
    _chatId: string,
    _model: string,
    _maxInputTokens: number,
    _pricing: UsagePricing,
  ): Promise<string | null> {
    return 'fake-usage';
  }

  async completeUsage(_id: string, _answer: Answer, _pricing: UsagePricing): Promise<void> {}

  async unknownUsage(_id: string): Promise<void> {}
}

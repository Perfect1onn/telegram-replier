import { Api, TelegramClient } from 'teleproto';
import { setTimeout as wait } from 'node:timers/promises';
import { EditedMessage, NewMessage, type NewMessageEvent } from 'teleproto/events';
import { FloodWaitError } from 'teleproto/errors';
import { StringSession } from 'teleproto/sessions';
import { Logger } from 'teleproto/extensions';
import type { ChatMessage } from '../../domain/types.ts';
import type { IPolicyEngine, ITelegramGateway } from '../../ports/contracts.ts';
import { readSessionFile } from '../security/session-file.ts';

export interface TelegramSettings {
  apiId: number;
  apiHash: string;
  expectedAccountId: string;
  sessionFile: string;
}

function messageNumber(value: string): number {
  const number = Number(value);

  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > 2147483647)
    throw new Error('Invalid Telegram message identifier');

  return number;
}

export function normalizeMessage(message: Api.Message, chatId: string): ChatMessage | null {
  if (!(message.peerId instanceof Api.PeerUser) || message.media || !message.message?.trim())
    return null;

  if (message.message.length > 16384) return null;

  const replyTo =
    message.replyTo instanceof Api.MessageReplyHeader ? message.replyTo.replyToMsgId : undefined;

  return {
    chatId,
    messageId: String(message.id),
    senderId: message.senderId?.toString() ?? chatId,
    direction: message.out ? 'OUTGOING' : 'INCOMING',
    source: 'TELEGRAM',
    text: message.message,
    occurredAt: new Date(message.date * 1000),
    ...(replyTo ? { replyToMessageId: String(replyTo) } : {}),
    ...(message.editDate ? { editedAt: new Date(message.editDate * 1000) } : {}),
  };
}

export async function retryFloodWait<T>(
  operation: () => Promise<T>,
  pause: (ms: number) => Promise<void>,
): Promise<T> {
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof FloodWaitError) ||
        !Number.isFinite(error.seconds) ||
        error.seconds < 0 ||
        error.seconds > 86400
      )
        throw error;

      await pause((Math.ceil(error.seconds) + 1) * 1000);
    }
  }
}

export class TeleprotoGateway implements ITelegramGateway {
  private settings: TelegramSettings;
  private client: TelegramClient | null = null;
  private historyAbort = new AbortController();
  private policy: IPolicyEngine;
  private onError: () => void;

  constructor(settings: TelegramSettings, policy: IPolicyEngine, onError: () => void) {
    this.settings = settings;
    this.policy = policy;
    this.onError = onError;
  }

  async connect(): Promise<void> {
    this.historyAbort = new AbortController();

    const session = await readSessionFile(this.settings.sessionFile);
    const logger = new Logger();

    logger.handler = () => {};

    const client = new TelegramClient(
      new StringSession(session),
      this.settings.apiId,
      this.settings.apiHash,
      {
        baseLogger: logger,
        connectionRetries: 3,
        requestRetries: 1,
        autoReconnect: true,
        floodSleepThreshold: 0,
      },
    );

    this.client = client;

    try {
      await client.connect();

      if (!(await client.checkAuthorization())) throw new Error('Telegram session unauthorized');

      const identity = await client.getMe();

      if (
        !(identity instanceof Api.User) ||
        identity.bot ||
        identity.id.toString() !== this.settings.expectedAccountId
      )
        throw new Error('Unexpected Telegram identity');
    } catch (error) {
      await client.disconnect();
      this.client = null;

      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.historyAbort.abort();

    const client = this.client;

    this.client = null;
    await client?.disconnect();
  }

  private connected(): TelegramClient {
    if (!this.client) throw new Error('Telegram disconnected');

    return this.client;
  }

  async listPrivateDialogs(): Promise<Array<{ chatId: string; title: string }>> {
    const dialogs = await this.connected().getDialogs({ limit: 200 });

    return dialogs.flatMap((dialog) => {
      const user = dialog.entity;

      if (!(user instanceof Api.User) || user.bot || user.self || user.deleted) return [];

      return [{ chatId: user.id.toString(), title: dialog.title?.trim() || user.id.toString() }];
    });
  }

  async subscribeMessages(
    handler: (message: ChatMessage) => Promise<void>,
  ): Promise<() => Promise<void>> {
    const client = this.connected();
    const builder = new NewMessage({});
    const editBuilder = new EditedMessage({});
    const callback = async (event: NewMessageEvent): Promise<void> => {
      try {
        if (!event.isPrivate || !(event.message.peerId instanceof Api.PeerUser)) return;

        const chatId = event.message.peerId.userId.toString();

        if (!(await this.policy.canIngest(chatId))) return;

        const entity = await client.getEntity(chatId);

        if (!(entity instanceof Api.User) || entity.bot || entity.self) return;

        const message = normalizeMessage(event.message, chatId);

        if (message) await handler(message);
      } catch {
        this.onError();
      }
    };

    client.addEventHandler(callback, builder);
    client.addEventHandler(callback, editBuilder);

    return async () => {
      client.removeEventHandler(callback, builder);
      client.removeEventHandler(callback, editBuilder);
    };
  }

  async getHistory(
    chatId: string,
    cursor?: string,
    limit = 100,
  ): Promise<{ items: ChatMessage[]; nextCursor?: string }> {
    if (!(await this.policy.canIngest(chatId))) throw new Error('History access denied');

    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid history limit');

    const client = this.connected();
    const page = await retryFloodWait(
      async () => {
        const entity = await client.getEntity(chatId);

        if (!(entity instanceof Api.User) || entity.bot || entity.self)
          throw new Error('Unsupported peer');

        return client.getMessages(entity, {
          limit,
          ...(cursor ? { offsetId: messageNumber(cursor) } : {}),
        });
      },
      async (ms) => {
        await wait(ms, undefined, {
          signal: this.historyAbort.signal,
        });
      },
    );
    const items = [];

    for (const message of page) {
      const item = normalizeMessage(message, chatId);

      if (item) items.push(item);
    }

    const last = page.at(-1);

    return { items, ...(page.length === limit && last ? { nextCursor: String(last.id) } : {}) };
  }

  async sendMessage(input: {
    chatId: string;
    text: string;
    replyToMessageId?: string;
    dedupeKey: string;
  }): Promise<{ messageId: string }> {
    const result = await this.connected().sendMessage(input.chatId, {
      message: input.text,
      ...(input.replyToMessageId ? { replyTo: messageNumber(input.replyToMessageId) } : {}),
      formattingEntities: [],
      linkPreview: false,
    });

    return { messageId: String(result.id) };
  }
}

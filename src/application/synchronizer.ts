import type { IPolicyEngine, ITelegramGateway, IWorkflowStore } from '../ports/contracts.ts';
import { AccessDeniedError } from '../domain/types.ts';

export class Synchronizer {
  private store: IWorkflowStore;
  private policy: IPolicyEngine;
  private gateway: ITelegramGateway;

  constructor(store: IWorkflowStore, policy: IPolicyEngine, gateway: ITelegramGateway) {
    this.store = store;
    this.policy = policy;
    this.gateway = gateway;
  }

  async backfillChat(chatId: string): Promise<boolean> {
    let checkpoint = await this.store.checkpoint(chatId);
    let changed = false;

    while (!checkpoint.complete) {
      if (!(await this.policy.canIngest(chatId))) throw new AccessDeniedError();

      const page = await this.gateway.getHistory(chatId, checkpoint.cursor, 100);

      if (page.nextCursor && page.nextCursor === checkpoint.cursor)
        throw new Error('History cursor stalled');

      if (page.items.some((m) => m.chatId !== chatId)) throw new AccessDeniedError();

      changed ||= page.items.length > 0;

      checkpoint = page.nextCursor
        ? { cursor: page.nextCursor, complete: false }
        : { complete: true };
      await this.store.saveHistory(chatId, page.items, checkpoint);
    }

    return changed;
  }

  async syncMissingMessages(chatId: string, baselineId?: string): Promise<boolean> {
    const baseline = baselineId ?? (await this.store.lastKnownMessageId(chatId));

    if (!baseline) return false;

    let checkpoint = await this.store.checkpoint(chatId, 'CATCHUP');
    let changed = false;

    if (checkpoint.complete) {
      checkpoint = { complete: false };
      await this.store.saveHistory(chatId, [], checkpoint, 'CATCHUP');
    }

    while (!checkpoint.complete) {
      if (!(await this.policy.canIngest(chatId))) throw new AccessDeniedError();

      const page = await this.gateway.getHistory(chatId, checkpoint.cursor, 100);

      if (page.nextCursor && page.nextCursor === checkpoint.cursor)
        throw new Error('History cursor stalled');

      if (page.items.some((message) => message.chatId !== chatId)) throw new AccessDeniedError();

      const newer = page.items.filter((message) => BigInt(message.messageId) > BigInt(baseline));
      const reachedBaseline = newer.length < page.items.length;

      changed ||= newer.length > 0;

      checkpoint =
        reachedBaseline || !page.nextCursor
          ? { complete: true }
          : { cursor: page.nextCursor, complete: false };
      await this.store.saveHistory(chatId, newer, checkpoint, 'CATCHUP');
    }

    return changed;
  }
}

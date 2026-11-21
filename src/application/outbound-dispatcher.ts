import type { Answer, ReplyInput } from '../domain/types.ts';
import type { IPolicyEngine, ITelegramGateway, IWorkflowStore } from '../ports/contracts.ts';
import { requiresReview } from './ai.service.ts';

export class OutboundDispatcher {
  private store: IWorkflowStore;
  private policy: IPolicyEngine;
  private gateway: ITelegramGateway;

  constructor(store: IWorkflowStore, policy: IPolicyEngine, gateway: ITelegramGateway) {
    this.store = store;
    this.policy = policy;
    this.gateway = gateway;
  }

  async dispatch(input: ReplyInput, answer: Answer, approved = false): Promise<void> {
    if (!(await this.store.current(input))) return;

    if (
      (!approved && requiresReview(answer.text)) ||
      !(await this.policy.canSend(input.chatId, input.configVersion, approved))
    ) {
      await this.store.saveDraft(input, answer);

      return;
    }

    const claim = await this.store.claimSend(input, answer, approved, Date.now());

    if (!claim) return;

    if (!(await this.policy.canSend(input.chatId, input.configVersion, approved))) {
      await this.store.finishSend(claim.id, null);

      return;
    }

    let result;

    try {
      result = await this.gateway.sendMessage({
        chatId: input.chatId,
        text: answer.text,
        replyToMessageId: input.triggerMessageId,
        dedupeKey: claim.id,
      });
    } catch {
      await this.store.finishSend(claim.id, null);

      return;
    }

    await this.store.finishSend(claim.id, result);
  }
}

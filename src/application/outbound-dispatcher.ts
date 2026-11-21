import type { Answer, ReplyInput } from '../domain/types.ts';
import { setTimeout as delay } from 'node:timers/promises';
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

    const parts = approved ? [answer.text] : (answer.parts ?? [answer.text]);
    const firstPart = parts[0] ?? answer.text;
    const claim = await this.store.claimSend(
      input,
      { ...answer, text: firstPart },
      approved,
      Date.now(),
    );

    if (!claim) return;

    if (!(await this.policy.canSend(input.chatId, input.configVersion, approved))) {
      await this.store.finishSend(claim.id, null);

      return;
    }

    let result;

    try {
      result = await this.gateway.sendMessage({
        chatId: input.chatId,
        text: firstPart,
        replyToMessageId: input.triggerMessageId,
        dedupeKey: claim.id,
      });
    } catch {
      await this.store.finishSend(claim.id, null);

      return;
    }

    await this.store.finishSend(claim.id, result);

    let previousId = claim.id;

    for (const part of parts.slice(1)) {
      await delay(1100);

      if (!(await this.policy.canSend(input.chatId, input.configVersion, false))) return;

      const followup = await this.store.claimFollowup(
        input,
        previousId,
        { ...answer, text: part },
        Date.now(),
      );

      if (!followup) return;

      let sent;

      try {
        sent = await this.gateway.sendMessage({
          chatId: input.chatId,
          text: part,
          dedupeKey: followup.id,
        });
      } catch {
        await this.store.finishSend(followup.id, null);

        return;
      }

      await this.store.finishSend(followup.id, sent);
      previousId = followup.id;
    }
  }
}

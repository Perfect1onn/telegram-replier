import type { ReplyInput, UsagePricing } from '../domain/types.ts';
import type { IPolicyEngine, IWorkflowStore } from '../ports/contracts.ts';
import type { AIService } from './ai.service.ts';
import type { ContextBuilder } from './context-builder.ts';
import type { OutboundDispatcher } from './outbound-dispatcher.ts';

export class ReplyProcessor {
  private store: IWorkflowStore;
  private policy: IPolicyEngine;
  private context: ContextBuilder;
  private ai: AIService;
  private dispatcher: OutboundDispatcher;
  private pricing: UsagePricing | undefined;
  private model: string | undefined;

  constructor(deps: {
    store: IWorkflowStore;
    policy: IPolicyEngine;
    context: ContextBuilder;
    ai: AIService;
    dispatcher: OutboundDispatcher;
    pricing?: UsagePricing;
    model?: string;
  }) {
    this.store = deps.store;
    this.policy = deps.policy;
    this.context = deps.context;
    this.ai = deps.ai;
    this.dispatcher = deps.dispatcher;
    this.pricing = deps.pricing;
    this.model = deps.model;
  }

  async process(input: ReplyInput): Promise<void> {
    if (!(await this.store.current(input)) || !(await this.policy.canGenerate(input.chatId)))
      return;

    const context = await this.context.buildContext(input.chatId, input.triggerMessageId);
    const usageId =
      this.pricing && this.model
        ? await this.store.reserveUsage(
            input.chatId,
            this.model,
            Buffer.byteLength(JSON.stringify(context)) + 4096,
            this.pricing,
          )
        : undefined;

    if (this.pricing && !usageId) {
      await this.store.audit({
        chatId: input.chatId,
        action: 'llm_budget_denied',
        reason: 'daily_budget_or_pause',
        at: new Date(),
      });

      return;
    }

    let answer;

    try {
      answer = await this.ai.generateAnswer(context);
    } catch {
      if (usageId) await this.store.unknownUsage(usageId);

      await this.store.audit({
        chatId: input.chatId,
        action: 'llm_failed',
        reason: 'request_outcome_unknown',
        at: new Date(),
      });

      return;
    }

    if (usageId && this.pricing) await this.store.completeUsage(usageId, answer, this.pricing);

    if (!(await this.store.current(input)) || !(await this.policy.canGenerate(input.chatId)))
      return;

    await this.dispatcher.dispatch(input, answer);
  }
}

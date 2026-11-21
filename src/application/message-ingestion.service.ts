import type { ChatMessage } from '../domain/types.ts';
import type { IPolicyEngine, IWorkflowStore } from '../ports/contracts.ts';

export class MessageIngestionService {
  private policy: IPolicyEngine;
  private store: IWorkflowStore;

  constructor(policy: IPolicyEngine, store: IWorkflowStore) {
    this.policy = policy;
    this.store = store;
  }

  async handle(message: ChatMessage): Promise<void> {
    if (!message.text.trim() || message.text.length > 16384 || message.source === 'AI') return;

    if (!Number.isFinite(message.occurredAt.getTime())) return;

    if (message.editedAt && !Number.isFinite(message.editedAt.getTime())) return;

    if (!(await this.policy.canIngest(message.chatId))) return;

    await this.store.ingest(message, Date.now());
  }
}

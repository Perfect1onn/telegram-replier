import type { Answer, ChatMessage, LLMContext } from '../../domain/types.ts';
import type { ILLMProvider, IRagService, ITelegramGateway } from '../../ports/contracts.ts';

export class FakeGateway implements ITelegramGateway {
  sent: { chatId: string; text: string; dedupeKey: string; replyToMessageId?: string }[] = [];
  privateDialogs: Array<{ chatId: string; title: string }> = [];
  fail = false;
  failAt?: number;
  history: ChatMessage[] = [];

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async listPrivateDialogs(): Promise<Array<{ chatId: string; title: string }>> {
    return this.privateDialogs;
  }

  async subscribeMessages(
    _handler: (message: ChatMessage) => Promise<void>,
  ): Promise<() => Promise<void>> {
    return async () => {};
  }

  async getHistory(chatId: string): Promise<{ items: ChatMessage[] }> {
    return { items: this.history.filter((m) => m.chatId === chatId) };
  }

  async sendMessage(input: {
    chatId: string;
    text: string;
    dedupeKey: string;
    replyToMessageId?: string;
  }): Promise<{ messageId: string }> {
    this.sent.push(input);

    if (this.fail || this.sent.length === this.failAt)
      throw new Error('Ambiguous transport failure');

    return { messageId: String(100000 + this.sent.length) };
  }
}

export class FakeProvider implements ILLMProvider {
  calls = 0;
  contexts: LLMContext[] = [];
  beforeAnswer?: () => Promise<void>;

  async generate(context: LLMContext, _signal: AbortSignal): Promise<Answer> {
    this.calls++;
    this.contexts.push(context);
    await this.beforeAnswer?.();

    return {
      text: 'Спасибо за сообщение.',
      model: 'fake',
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
    };
  }
}

export class EmptyRag implements IRagService {
  async searchRelevantContext(): Promise<[]> {
    return [];
  }
}

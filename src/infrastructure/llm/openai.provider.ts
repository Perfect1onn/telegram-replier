import OpenAI from 'openai';
import type { Answer, LLMContext } from '../../domain/types.ts';
import type { ILLMProvider } from '../../ports/contracts.ts';

export class OpenAIProvider implements ILLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(client: OpenAI, model: string) {
    this.client = client;
    this.model = model;
  }

  async generate(context: LLMContext, signal: AbortSignal): Promise<Answer> {
    const response = await this.client.responses.create(
      {
        model: this.model,
        instructions: context.instructions,
        input: [
          {
            role: 'user',
            content: JSON.stringify({
              conversation: context.recentMessages,
              referenceData: context.retrievedMemories,
              currentMessage: context.currentMessage,
            }),
          },
        ],
        max_output_tokens: 1024,
        store: false,
      },
      { signal, timeout: 30000 },
    );

    if (response.status !== 'completed' || !response.usage)
      throw new Error('Incomplete model response');

    return {
      text: response.output_text,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cachedInputTokens: response.usage.input_tokens_details.cached_tokens,
      },
    };
  }
}

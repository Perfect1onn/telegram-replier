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
        ...(this.model === 'gpt-6.1-terra' ? { reasoning: { effort: 'none' as const } } : {}),
        instructions: context.instructions,
        text: {
          format: {
            type: 'json_schema',
            name: 'telegram_reply',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                messages: {
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 1,
                  maxItems: 3,
                },
              },
              required: ['messages'],
              additionalProperties: false,
            },
          },
        },
        input: [
          {
            role: 'user',
            content: JSON.stringify({
              conversation: context.recentMessages,
              referenceData: context.retrievedMemories.map((memory) => ({
                source: memory.chatId === context.chatId ? 'current_chat' : 'other_chat',
                content: memory.content,
              })),
              chatSummary: context.chatSummary,
              ownerProfile: context.ownerProfile,
              ownerExamples: context.ownerExamples,
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
        cacheWriteTokens: response.usage.input_tokens_details.cache_write_tokens,
      },
    };
  }
}

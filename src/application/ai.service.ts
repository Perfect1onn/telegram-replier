import type { Answer, LLMContext, Usage } from '../domain/types.ts';
import type { ILLMProvider } from '../ports/contracts.ts';

export function requiresReview(text: string): boolean {
  return /(?:password|secret|api.?key|transfer|payment|promise|bank|meet|not sure|uncertain|парол|секрет|перевед|опла|обещ|встреч|не уверен|не знаю)/iu.test(
    text,
  );
}

export function estimateCost(
  usage: Usage,
  prices: { input: number; output: number; cached: number },
): number {
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    ...Object.values(prices),
  ];

  if (
    values.some((v) => !Number.isFinite(v) || v < 0) ||
    usage.cachedInputTokens > usage.inputTokens
  )
    throw new Error('Invalid usage/pricing');

  return (
    ((usage.inputTokens - usage.cachedInputTokens) * prices.input +
      usage.cachedInputTokens * prices.cached +
      usage.outputTokens * prices.output) /
    1000000
  );
}

export class AIService {
  private provider: ILLMProvider;

  constructor(provider: ILLMProvider) {
    this.provider = provider;
  }

  async generateAnswer(context: LLMContext): Promise<Answer> {
    const answer = await this.provider.generate(context, AbortSignal.timeout(30000));
    const text = answer.text.trim();

    if (!text || text.length > 4096 || /\p{Cc}/u.test(text.replace(/[\n\t\r]/g, '')))
      throw new Error('Invalid model output');

    return { ...answer, text };
  }
}

import type { Answer, LLMContext, Usage } from '../domain/types.ts';
import type { ILLMProvider } from '../ports/contracts.ts';

export function requiresReview(text: string): boolean {
  return /(?:password|secret|api.?key|transfer|payment|promise|bank|meet|not sure|uncertain|парол|секрет|перевед|опла|обещ|встреч|не уверен|не знаю)/iu.test(
    text,
  );
}

export function estimateCost(
  usage: Usage,
  prices: { input: number; output: number; cached: number; cacheWrite?: number },
): number {
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    cacheWriteTokens,
    ...Object.values(prices),
  ];

  if (
    values.some((v) => !Number.isFinite(v) || v < 0) ||
    usage.cachedInputTokens + cacheWriteTokens > usage.inputTokens
  )
    throw new Error('Invalid usage/pricing');

  return (
    ((usage.inputTokens - usage.cachedInputTokens - cacheWriteTokens) * prices.input +
      usage.cachedInputTokens * prices.cached +
      cacheWriteTokens * (prices.cacheWrite ?? prices.input) +
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
    const text = answer.text
      .trim()
      .replace(/^```[^\n]*\n?|^```\s*$/gm, '')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
      .replace(
        /\*\*([^*]+)\*\*|__([^_]+)__/g,
        (_match, bold: string, underlined: string) => bold ?? underlined,
      )
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 $2')
      .replace(
        /(?<!\w)(?:\*([^*\n]+)\*|_([^_\n]+)_|~~([^~\n]+)~~)(?!\w)/g,
        (_match, italic: string, underlined: string, crossed: string) =>
          italic ?? underlined ?? crossed,
      )
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s*[—–]\s*|\s+-\s+/g, ', ')
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!text || text.length > 4096 || /\p{Cc}/u.test(text.replace(/[\n\t\r]/g, '')))
      throw new Error('Invalid model output');

    return { ...answer, text };
  }
}

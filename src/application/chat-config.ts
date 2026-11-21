import type { ChatConfig } from '../domain/types.ts';

export type ChatPatch = Partial<Omit<ChatConfig, 'chatId' | 'version'>>;

export function validateChatPatch(patch: ChatPatch): void {
  const keys = [
    'enabled',
    'mode',
    'replyDelayMs',
    'recentMessageLimit',
    'cancelOnManualReply',
    'maxRepliesPerHour',
    'systemPrompt',
  ];

  if (Object.keys(patch).some((key) => !keys.includes(key))) throw new Error('Invalid chat field');

  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean')
    throw new Error('Invalid enabled');

  if (patch.cancelOnManualReply !== undefined && typeof patch.cancelOnManualReply !== 'boolean')
    throw new Error('Invalid cancelOnManualReply');

  if (patch.mode !== undefined && !['OFF', 'DRAFT', 'AUTO'].includes(patch.mode))
    throw new Error('Invalid mode');

  for (const [key, min, max] of [
    ['replyDelayMs', 1000, 300000],
    ['recentMessageLimit', 1, 50],
    ['maxRepliesPerHour', 1, 100],
  ] as const) {
    const value = patch[key];

    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max))
      throw new Error(`Invalid ${key}`);
  }

  if (
    patch.systemPrompt !== undefined &&
    (typeof patch.systemPrompt !== 'string' || patch.systemPrompt.length > 8000)
  )
    throw new Error('Invalid systemPrompt');
}

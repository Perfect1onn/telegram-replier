export type ReplyMode = 'OFF' | 'DRAFT' | 'AUTO';

export interface ChatMessage {
  chatId: string;
  messageId: string;
  senderId: string;
  direction: 'INCOMING' | 'OUTGOING';
  source: 'TELEGRAM' | 'AI';
  text: string;
  occurredAt: Date;
  replyToMessageId?: string;
  editedAt?: Date;
}

export interface ChatConfig {
  chatId: string;
  enabled: boolean;
  mode: ReplyMode;
  version: number;
  replyDelayMs: number;
  recentMessageLimit: number;
  cancelOnManualReply: boolean;
  maxRepliesPerHour: number;
  systemPrompt?: string;
}

export interface ReplyInput {
  chatId: string;
  triggerMessageId: string;
  generation: number;
  configVersion: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens?: number;
}

export interface UsagePricing {
  prices: { input: number; output: number; cached: number; cacheWrite?: number };
  version: string;
  effectiveAt: Date;
  dailyBudgetUsd: number;
}

export interface Answer {
  text: string;
  parts?: string[];
  model: string;
  usage: Usage;
}

export interface RetrievedChunk {
  id: string;
  chatId: string;
  content: string;
  messageIds: string[];
  score: number;
}

export interface LLMContext {
  chatId: string;
  instructions: string;
  recentMessages: ChatMessage[];
  retrievedMemories: RetrievedChunk[];
  chatSummary?: string;
  ownerProfile?: { about: string; style: string; boundaries: string };
  ownerExamples?: string[];
  currentMessage: ChatMessage;
}

export interface ReplyOperation extends ReplyInput {
  id: string;
  dueAt: number;
  status: 'PENDING' | 'DRAFT' | 'SENDING' | 'SENT' | 'UNKNOWN' | 'CANCELLED' | 'REJECTED';
  answer?: Answer;
  telegramMessageId?: string;
}

export interface AuditEvent {
  chatId: string;
  action: string;
  reason: string;
  at: Date;
}

export interface SyncStatus {
  cursor?: string;
  complete: boolean;
}

export const defaultChat = (chatId: string): ChatConfig => ({
  chatId,
  enabled: true,
  mode: 'OFF',
  version: 1,
  replyDelayMs: 12000,
  recentMessageLimit: 15,
  cancelOnManualReply: true,
  maxRepliesPerHour: 20,
});

export class ConflictError extends Error {}

export class AccessDeniedError extends Error {}

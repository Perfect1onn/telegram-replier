import type {
  Answer,
  AuditEvent,
  ChatConfig,
  ChatMessage,
  LLMContext,
  ReplyInput,
  ReplyOperation,
  RetrievedChunk,
  SyncStatus,
  UsagePricing,
} from '../domain/types.ts';
import type { ChatPatch } from '../application/chat-config.ts';

export interface IChatService {
  getChat(chatId: string): Promise<ChatConfig | null>;
}

export interface IChatAdminService extends IChatService {
  updateChat(chatId: string, patch: ChatPatch, expectedVersion: number): Promise<ChatConfig>;
}

export interface IPolicyEngine {
  canIngest(chatId: string): Promise<boolean>;
  canGenerate(chatId: string): Promise<boolean>;
  canSend(chatId: string, version: number, approved: boolean): Promise<boolean>;
}

export interface IMessageRepository {
  getRecent(chatId: string, limit: number): Promise<ChatMessage[]>;
  getByIds(chatId: string, ids: readonly string[]): Promise<ChatMessage[]>;
}

export interface IWorkflowStore extends IChatAdminService, IMessageRepository {
  ingest(message: ChatMessage, now: number): Promise<void>;
  current(input: ReplyInput): Promise<boolean>;
  saveDraft(input: ReplyInput, answer: Answer): Promise<void>;
  claimSend(
    input: ReplyInput,
    answer: Answer,
    approved: boolean,
    now: number,
  ): Promise<ReplyOperation | null>;
  finishSend(id: string, result: { messageId: string } | null): Promise<void>;
  audit(event: AuditEvent): Promise<void>;
  saveHistory(
    chatId: string,
    messages: ChatMessage[],
    checkpoint: SyncStatus,
    kind?: 'BACKFILL' | 'CATCHUP',
  ): Promise<void>;
  checkpoint(chatId: string, kind?: 'BACKFILL' | 'CATCHUP'): Promise<SyncStatus>;
  lastKnownMessageId(chatId: string): Promise<string | null>;
  reserveUsage(
    chatId: string,
    model: string,
    maxInputTokens: number,
    pricing: UsagePricing,
  ): Promise<string | null>;
  completeUsage(id: string, answer: Answer, pricing: UsagePricing): Promise<void>;
  unknownUsage(id: string): Promise<void>;
}

export interface ITelegramGateway {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribeMessages(handler: (message: ChatMessage) => Promise<void>): Promise<() => Promise<void>>;
  getHistory(
    chatId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: ChatMessage[]; nextCursor?: string }>;
  sendMessage(input: {
    chatId: string;
    text: string;
    replyToMessageId: string;
    dedupeKey: string;
  }): Promise<{ messageId: string }>;
}

export interface ILLMProvider {
  generate(context: LLMContext, signal: AbortSignal): Promise<Answer>;
}

export interface IRagService {
  searchRelevantContext(chatId: string, query: string, limit: number): Promise<RetrievedChunk[]>;
}

export interface IEmbeddingService {
  embedDocuments(texts: readonly string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}

export interface IIndexingScheduler {
  schedule(chatId: string): Promise<void>;
}

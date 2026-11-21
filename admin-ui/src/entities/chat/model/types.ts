export interface Chat {
  chatId: string;
  enabled: boolean;
  mode: 'OFF' | 'DRAFT' | 'AUTO';
  version: number;
  replyDelayMs: number;
  recentMessageLimit: number;
  cancelOnManualReply: boolean;
  maxRepliesPerHour: number;
  systemPrompt?: string;
}

export interface ChatProgress {
  history: {
    state: 'NOT_STARTED' | 'PENDING' | 'COMPLETE';
    lastSuccessAt: string | null;
    updatedAt: string | null;
  };
  storedMessages: number;
  indexedMessages: number;
  indexedChunks: number;
  bufferedMessages: number;
  indexUpdatedAt: string | null;
  summary: {
    status: 'NOT_STARTED' | 'PENDING' | 'BUDGET' | 'COMPLETE';
    processed: number;
    since: string | null;
    updatedAt: string | null;
  };
}

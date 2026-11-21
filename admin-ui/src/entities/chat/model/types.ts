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

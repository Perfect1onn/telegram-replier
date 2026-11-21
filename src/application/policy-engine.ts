import type { IChatService, IPolicyEngine } from '../ports/contracts.ts';

export class PolicyEngine implements IPolicyEngine {
  private chats: IChatService;
  private enabled: () => boolean | Promise<boolean>;

  constructor(chats: IChatService, enabled: () => boolean | Promise<boolean>) {
    this.chats = chats;
    this.enabled = enabled;
  }

  async canIngest(chatId: string): Promise<boolean> {
    try {
      const chat = await this.chats.getChat(chatId);

      return Boolean(chat?.enabled && chat.mode !== 'OFF');
    } catch {
      return false;
    } // Policy infrastructure failures always deny access.
  }

  async canGenerate(chatId: string): Promise<boolean> {
    try {
      return (await this.enabled()) && (await this.canIngest(chatId));
    } catch {
      return false;
    }
  }

  async canSend(chatId: string, version: number, approved = false): Promise<boolean> {
    try {
      if (!(await this.enabled())) return false;

      const chat = await this.chats.getChat(chatId);

      return Boolean(
        chat?.enabled &&
        chat.version === version &&
        (chat.mode === 'AUTO' || (approved && chat.mode === 'DRAFT')),
      );
    } catch {
      return false;
    }
  }
}

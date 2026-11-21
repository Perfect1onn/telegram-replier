import type { PrismaClient } from '@prisma/client';
import type { IPersonalMemory } from '../../ports/contracts.ts';

export class PersonalMemory implements IPersonalMemory {
  private db: PrismaClient;

  constructor(db: PrismaClient) {
    this.db = db;
  }

  async getChatSummary(chatId: string): Promise<string> {
    const state = await this.db.chatSummary.findUnique({ where: { chatId } });

    return state?.status === 'COMPLETE' ? state.content : '';
  }

  async getProfile(): Promise<{ about: string; style: string; boundaries: string }> {
    const profile = await this.db.ownerProfile.findUnique({ where: { id: 1 } });

    return {
      about: [
        profile?.name ? `Имя: ${profile.name}` : '',
        profile?.about ? `О себе: ${profile.about}` : '',
        profile?.work ? `Работа: ${profile.work}` : '',
        profile?.interests ? `Интересы: ${profile.interests}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      style: profile?.style ?? '',
      boundaries: profile?.boundaries ?? 'Не раскрывать секреты и личные сведения собеседников.',
    };
  }
}

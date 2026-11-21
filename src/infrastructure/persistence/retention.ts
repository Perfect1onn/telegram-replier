import type { PrismaClient } from '@prisma/client';

export class RetentionService {
  private db: PrismaClient;
  private days: number;

  constructor(db: PrismaClient, days: number) {
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Invalid retention');

    this.db = db;
    this.days = days;
  }

  async run(now = new Date(), shouldStop: () => boolean = () => false): Promise<number> {
    const cutoff = new Date(now.getTime() - this.days * 86400000);
    let processed = 0;

    for (;;) {
      if (shouldStop()) break;

      const chats = await this.db.$queryRaw<Array<{ chat_id: string }>>`
        SELECT DISTINCT m.chat_id FROM messages m
        WHERE m.occurred_at < ${cutoff}
          AND NOT EXISTS (
            SELECT 1 FROM reply_operations r WHERE r.chat_id = m.chat_id
              AND r.status IN ('SENDING','UNKNOWN')
          )
        ORDER BY m.chat_id LIMIT 100`;

      if (!chats.length) break;

      for (const { chat_id: chatId } of chats) {
        if (shouldStop()) break;

        const deleted = await this.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM system_state WHERE id = 1 FOR UPDATE`;
          await tx.$queryRaw`SELECT chat_id FROM allowed_chats WHERE chat_id = ${chatId} FOR UPDATE`;

          if (
            await tx.replyOperation.count({
              where: { chatId, status: { in: ['SENDING', 'UNKNOWN'] } },
            })
          )
            return false;

          await tx.$executeRaw`
            DELETE FROM conversation_chunks c
            WHERE c.chat_id = ${chatId}
              AND EXISTS (
                SELECT 1 FROM unnest(c.message_ids) AS chunk_message_id
                WHERE NOT EXISTS (
                  SELECT 1 FROM messages m
                  WHERE m.chat_id = c.chat_id
                    AND m.message_id = chunk_message_id
                    AND m.occurred_at >= ${cutoff}
                )
              )`;
          await tx.indexingState.deleteMany({ where: { chatId } });
          await tx.draft.deleteMany({ where: { chatId, createdAt: { lt: cutoff } } });
          await tx.replyOperation.updateMany({
            where: { chatId, createdAt: { lt: cutoff }, status: { in: ['PENDING', 'DRAFT'] } },
            data: { status: 'CANCELLED', updatedAt: now },
          });
          await tx.replyOperation.deleteMany({
            where: {
              chatId,
              createdAt: { lt: cutoff },
              status: { in: ['SENT', 'CANCELLED', 'REJECTED'] },
            },
          });
          await tx.jobOutbox.deleteMany({
            where: { chatId, dueAt: { lt: cutoff }, publishedAt: { not: null } },
          });
          await tx.message.deleteMany({ where: { chatId, occurredAt: { lt: cutoff } } });

          return true;
        });

        if (deleted) processed += 1;
      }

      if (chats.length < 100) break;
    }

    await this.db.$transaction(async (tx) => {
      await tx.llmUsage.deleteMany({
        where: { createdAt: { lt: cutoff }, status: { in: ['COMPLETED', 'FAILED'] } },
      });
      await tx.auditEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    });

    return processed;
  }
}

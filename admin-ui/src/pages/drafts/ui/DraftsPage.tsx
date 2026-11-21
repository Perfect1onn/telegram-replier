import { useEffect, useState } from 'react';
import type { Draft } from '../../../entities/draft/model/types';
import { request } from '../../../shared/api/client';

export function DraftsPage({
  reload,
  onError,
}: {
  reload: number;
  onError: (message: string) => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busyId, setBusyId] = useState('');

  async function load(more = false) {
    const result = await request<{ items: Draft[]; nextCursor: string | null }>(
      `/api/drafts?limit=20${more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    setDrafts(more ? (previous) => [...previous, ...result.items] : result.items);
    setCursor(result.nextCursor);
  }

  useEffect(() => {
    void load().catch((error: Error) => onError(error.message));
  }, [reload]);

  async function review(draft: Draft, action: 'approve' | 'reject') {
    const message =
      action === 'approve' ? `Отправить этот текст в чат ${draft.chatId}?` : 'Отклонить черновик?';
    if (!confirm(message)) return;
    setBusyId(draft.id);
    try {
      await request(`/api/drafts/${draft.id}/${action}`, { method: 'POST' });
      await load();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusyId('');
    }
  }

  return (
    <>
      <header className="page-heading">
        <p className="eyebrow">ОЧЕРЕДЬ / ЧЕРНОВИКИ</p>
        <h1>На проверке</h1>
        <p className="muted">Одобрение сразу отправит текст в Telegram.</p>
      </header>
      <div className="item-list">
        {drafts.length ? (
          drafts.map((draft) => (
            <article className="item stacked" key={draft.id}>
              <div className="item-meta">
                <h3>Чат {draft.chatId}</h3>
                <span>{new Date(draft.createdAt).toLocaleString('ru-RU')}</span>
              </div>
              <p className="small-muted">Ответ на сообщение {draft.triggerMessageId}</p>
              <div className="message">{draft.text}</div>
              <div className="item-actions">
                <button
                  className="subtle-danger"
                  disabled={!!busyId}
                  onClick={() => void review(draft, 'reject')}
                >
                  Отклонить
                </button>
                <button
                  className="primary"
                  disabled={!!busyId}
                  onClick={() => void review(draft, 'approve')}
                >
                  Одобрить и отправить
                </button>
              </div>
            </article>
          ))
        ) : (
          <div className="empty">Черновиков на проверке нет.</div>
        )}
      </div>
      {cursor && (
        <button
          className="secondary load-more"
          onClick={() => void load(true).catch((error: Error) => onError(error.message))}
        >
          Показать ещё
        </button>
      )}
    </>
  );
}

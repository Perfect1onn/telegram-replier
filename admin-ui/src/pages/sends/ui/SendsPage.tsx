import { useEffect, useState } from 'react';
import type { UnknownSend } from '../../../entities/send/model/types';
import { request } from '../../../shared/api/client';

export function SendsPage({
  reload,
  onError,
}: {
  reload: number;
  onError: (message: string) => void;
}) {
  const [sends, setSends] = useState<UnknownSend[]>([]);
  const [busyId, setBusyId] = useState('');

  async function load() {
    const result = await request<{ items: UnknownSend[] }>('/api/sends/unknown?limit=100');
    setSends(result.items);
  }

  useEffect(() => {
    void load().catch((error: Error) => onError(error.message));
  }, [reload]);

  async function reconcile(send: UnknownSend, outcome: 'SENT' | 'NOT_SENT') {
    let telegramMessageId: string | undefined;

    if (outcome === 'SENT') {
      const supplied = prompt('Введите ID отправленного сообщения из истории Telegram:');
      if (!supplied) return;
      if (!/^\d+$/.test(supplied)) {
        onError('ID сообщения должен состоять из цифр');
        return;
      }
      telegramMessageId = supplied;
    } else if (
      prompt(`После независимой проверки истории введите НЕ ОТПРАВЛЕНО ${send.id}`) !==
      `НЕ ОТПРАВЛЕНО ${send.id}`
    )
      return;

    setBusyId(send.id);
    try {
      await request(`/api/sends/${send.id}/reconcile`, {
        method: 'POST',
        body: { outcome, telegramMessageId, confirm: `RECONCILE ${send.id}` },
      });
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
        <p className="eyebrow">ОТПРАВКИ / РАЗБОР</p>
        <h1>Неясный исход</h1>
        <p className="muted">
          Telegram не подтвердил результат. Повторная отправка заблокирована до сверки.
        </p>
      </header>
      <div className="notice">
        <strong>Проверьте историю Telegram.</strong> Отсутствие сообщения в одной странице истории
        не доказывает, что оно не было отправлено.
      </div>
      <div className="item-list">
        {sends.length ? (
          sends.map((send) => (
            <article className="item stacked" key={send.id}>
              <div className="item-meta">
                <h3>Чат {send.chatId}</h3>
                <span>{new Date(send.updatedAt).toLocaleString('ru-RU')}</span>
              </div>
              <p className="small-muted">
                Отправка {send.id} · Ответ на сообщение {send.triggerMessageId}
              </p>
              <div className="message">{send.generatedText ?? 'Текст недоступен'}</div>
              <div className="item-actions">
                <button
                  className="subtle-danger"
                  disabled={!!busyId}
                  onClick={() => void reconcile(send, 'NOT_SENT')}
                >
                  Не отправлено
                </button>
                <button
                  className="secondary"
                  disabled={!!busyId}
                  onClick={() => void reconcile(send, 'SENT')}
                >
                  Найдено в Telegram
                </button>
              </div>
            </article>
          ))
        ) : (
          <div className="empty">Отправок с неясным исходом нет.</div>
        )}
      </div>
    </>
  );
}

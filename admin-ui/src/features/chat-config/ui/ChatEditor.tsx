import { useEffect, useState, type FormEvent } from 'react';
import type { Chat, ChatProgress } from '../../../entities/chat/model/types';
import { request } from '../../../shared/api/client';

export function ChatEditor({
  chat,
  onClose,
  onSaved,
  onError,
}: {
  chat: Chat;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState(chat);
  const [busy, setBusy] = useState(false);
  const [backfill, setBackfill] = useState('');
  const [progress, setProgress] = useState<ChatProgress | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(false);
  const canBackfill = chat.enabled && chat.mode !== 'OFF';

  async function loadProgress() {
    setLoadingProgress(true);
    try {
      setProgress(await request<ChatProgress>(`/api/chats/${chat.chatId}/progress`));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setLoadingProgress(false);
    }
  }

  useEffect(() => {
    void loadProgress();
  }, [chat.chatId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (
      form.mode === 'AUTO' &&
      chat.mode !== 'AUTO' &&
      !confirm('Разрешить автоматические ответы для этого чата после включения AUTO на сервере?')
    )
      return;
    setBusy(true);
    try {
      await request(`/api/chats/${chat.chatId}`, {
        method: 'PUT',
        body: {
          expectedVersion: chat.version,
          patch: {
            enabled: form.enabled,
            mode: form.mode,
            replyDelayMs: form.replyDelayMs,
            recentMessageLimit: form.recentMessageLimit,
            cancelOnManualReply: form.cancelOnManualReply,
            maxRepliesPerHour: form.maxRepliesPerHour,
            systemPrompt: form.systemPrompt ?? '',
          },
        },
      });
      onSaved();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function queueBackfill() {
    if (!canBackfill) return;
    if (!confirm(`Загрузить историю чата ${chat.chatId}?`)) return;
    try {
      const result = await request<{ jobId: string }>(`/api/chats/${chat.chatId}/backfill`, {
        method: 'POST',
      });
      setBackfill(`Задача ${result.jobId} добавлена`);
      void loadProgress();
    } catch (error) {
      onError((error as Error).message);
    }
  }

  async function purge() {
    const phrase = `PURGE ${chat.chatId}`;
    if (prompt(`Для удаления всех данных введите ${phrase}`) !== phrase) return;
    try {
      await request(`/api/chats/${chat.chatId}/data`, {
        method: 'DELETE',
        body: { confirm: phrase },
      });
      onSaved();
    } catch (error) {
      onError((error as Error).message);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-editor-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">НАСТРОЙКИ ЧАТА</p>
            <h2 id="chat-editor-title">Чат {chat.chatId}</h2>
            <p className="small-muted">Версия {chat.version}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </div>
        <section className="chat-progress" aria-label="Состояние истории и индекса">
          <div className="chat-progress-head">
            <h3>История и индекс</h3>
            <button
              className="secondary"
              type="button"
              disabled={loadingProgress}
              onClick={() => void loadProgress()}
            >
              {loadingProgress ? 'Обновляю…' : 'Обновить'}
            </button>
          </div>
          {progress ? (
            <div className="chat-progress-grid">
              <div>
                <span>Загрузка истории</span>
                <strong>
                  {progress.history.state === 'COMPLETE'
                    ? 'Завершена'
                    : progress.history.state === 'PENDING'
                      ? 'Не завершена'
                      : 'Не запускалась'}
                </strong>
                <small>
                  {progress.history.lastSuccessAt
                    ? `Последний прогресс: ${new Date(progress.history.lastSuccessAt).toLocaleString('ru-RU')}`
                    : 'Нет отметки о загрузке'}
                </small>
              </div>
              <div>
                <span>Сообщения</span>
                <strong>{progress.storedMessages.toLocaleString('ru-RU')}</strong>
                <small>Сохранено в базе</small>
              </div>
              <div>
                <span>Поисковый индекс</span>
                <strong>
                  {progress.indexedMessages.toLocaleString('ru-RU')} /{' '}
                  {progress.storedMessages.toLocaleString('ru-RU')}
                </strong>
                <small>
                  {progress.indexedChunks.toLocaleString('ru-RU')} фрагментов
                  {progress.bufferedMessages ? ` · ${progress.bufferedMessages} в буфере` : ''}
                </small>
              </div>
            </div>
          ) : (
            <p className="small-muted">
              {loadingProgress ? 'Загружаю состояние…' : 'Нет данных о состоянии.'}
            </p>
          )}
        </section>
        <form onSubmit={(event) => void save(event)}>
          <div className="form-grid">
            <label className="check">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              />{' '}
              Чат включён
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.cancelOnManualReply}
                onChange={(event) =>
                  setForm({ ...form, cancelOnManualReply: event.target.checked })
                }
              />{' '}
              Отменять при ручном ответе
            </label>
            <label>
              Режим
              <select
                value={form.mode}
                onChange={(event) => setForm({ ...form, mode: event.target.value as Chat['mode'] })}
              >
                <option value="OFF">OFF — без ответов</option>
                <option value="DRAFT">DRAFT — на проверку</option>
                <option value="AUTO">AUTO — автоматически</option>
              </select>
            </label>
            <label>
              Задержка, мс
              <input
                type="number"
                min="1000"
                max="300000"
                required
                value={form.replyDelayMs}
                onChange={(event) => setForm({ ...form, replyDelayMs: Number(event.target.value) })}
              />
            </label>
            <label>
              Сообщений в контексте
              <input
                type="number"
                min="1"
                max="50"
                required
                value={form.recentMessageLimit}
                onChange={(event) =>
                  setForm({ ...form, recentMessageLimit: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Ответов в час
              <input
                type="number"
                min="1"
                max="100"
                required
                value={form.maxRepliesPerHour}
                onChange={(event) =>
                  setForm({ ...form, maxRepliesPerHour: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <label>
            Системная инструкция
            <textarea
              rows={5}
              maxLength={8000}
              value={form.systemPrompt ?? ''}
              onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })}
            />
          </label>
          {backfill && <p className="small-muted">{backfill}</p>}
          {!canBackfill && (
            <p className="small-muted">
              Для загрузки истории включите чат, выберите DRAFT или AUTO и сохраните настройки.
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="subtle-danger" onClick={() => void purge()}>
              Удалить данные
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!canBackfill || busy}
              onClick={() => void queueBackfill()}
            >
              Загрузить историю
            </button>
            <button className="primary" disabled={busy}>
              Сохранить
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import type { Chat } from '../../../entities/chat/model/types';
import { ChatEditor } from '../../../features/chat-config/ui/ChatEditor';
import { request } from '../../../shared/api/client';

interface TelegramDialog {
  chatId: string;
  title: string;
}

export function ChatsPage({
  reload,
  onError,
}: {
  reload: number;
  onError: (message: string) => void;
}) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [newId, setNewId] = useState('');
  const [selected, setSelected] = useState<Chat | null>(null);
  const [dialogs, setDialogs] = useState<TelegramDialog[]>([]);
  const [dialogsLoaded, setDialogsLoaded] = useState(false);
  const [dialogSearch, setDialogSearch] = useState('');
  const [loadingDialogs, setLoadingDialogs] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);

  async function load(more = false) {
    const result = await request<{ items: Chat[]; nextCursor: string | null }>(
      `/api/chats?limit=20${more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    setChats(more ? (previous) => [...previous, ...result.items] : result.items);
    setCursor(result.nextCursor);
  }

  useEffect(() => {
    void load().catch((error: Error) => onError(error.message));
    void loadDialogs();
  }, [reload]);

  async function loadDialogs() {
    setLoadingDialogs(true);
    try {
      const result = await request<{ items: TelegramDialog[] }>('/api/telegram/dialogs');
      setDialogs(result.items);
      setDialogsLoaded(true);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setLoadingDialogs(false);
    }
  }

  async function addChat(chatId: string) {
    setAddingId(chatId);
    try {
      const chat = await request<Chat>('/api/chats', {
        method: 'POST',
        body: { chatId },
      });
      setNewId('');
      await load();
      setSelected(chat);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setAddingId(null);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    await addChat(newId.trim());
  }

  const allowedIds = new Set(chats.map((chat) => chat.chatId));
  const dialogTitles = new Map(dialogs.map((dialog) => [dialog.chatId, dialog.title]));
  const visibleDialogs = dialogs.filter(
    (dialog) =>
      !allowedIds.has(dialog.chatId) &&
      `${dialog.title} ${dialog.chatId}`.toLowerCase().includes(dialogSearch.toLowerCase().trim()),
  );

  return (
    <>
      <header className="page-heading">
        <p className="eyebrow">КОНФИГУРАЦИЯ / ЧАТЫ</p>
        <h1>Разрешённые чаты</h1>
        <p className="muted">У каждого чата свой режим, лимиты и системная инструкция.</p>
      </header>
      <section className="add-panel dialog-panel" aria-labelledby="telegram-dialogs-title">
        <div className="dialog-panel-heading">
          <div>
            <h2 id="telegram-dialogs-title">Личные диалоги Telegram</h2>
            <p>Выбери чат из подключённого аккаунта. Добавление не включает автоответы.</p>
          </div>
          <button
            className="secondary"
            type="button"
            onClick={() => void loadDialogs()}
            disabled={loadingDialogs}
          >
            {loadingDialogs ? 'Загружаю…' : 'Обновить список'}
          </button>
        </div>
        {dialogs.length > 0 && (
          <>
            <input
              aria-label="Поиск диалога"
              placeholder="Поиск по имени или ID"
              value={dialogSearch}
              onChange={(event) => setDialogSearch(event.target.value)}
            />
            <div className="dialog-list">
              {visibleDialogs.length ? (
                visibleDialogs.map((dialog) => (
                  <div className="dialog-row" key={dialog.chatId}>
                    <div>
                      <strong>{dialog.title}</strong>
                      <small>ID {dialog.chatId}</small>
                    </div>
                    <button
                      className="secondary"
                      type="button"
                      disabled={addingId !== null}
                      onClick={() => void addChat(dialog.chatId)}
                    >
                      {addingId === dialog.chatId ? 'Добавляю…' : 'Добавить'}
                    </button>
                  </div>
                ))
              ) : (
                <p>Подходящих чатов нет.</p>
              )}
            </div>
          </>
        )}
        {dialogsLoaded && dialogs.length === 0 && <p>Личных диалогов не найдено.</p>}
      </section>
      <form className="add-panel" onSubmit={(event) => void add(event)}>
        <label>
          Добавить вручную по Telegram ID
          <input
            inputMode="numeric"
            pattern="[1-9][0-9]*"
            value={newId}
            onChange={(event) => setNewId(event.target.value)}
            placeholder="123456789"
            required
          />
        </label>
        <button className="primary">Добавить чат</button>
        <p>Новый чат создаётся в режиме OFF.</p>
      </form>
      <h2 className="section-title">
        Чаты <span className="count">{chats.length}</span>
      </h2>
      <div className="item-list">
        {chats.length ? (
          chats.map((chat) => (
            <article className="item" key={chat.chatId}>
              <div>
                <h3>{dialogTitles.get(chat.chatId) || `Чат ${chat.chatId}`}</h3>
                <small className="chat-id">ID {chat.chatId}</small>
                <span className={`badge ${chat.mode.toLowerCase()}`}>{chat.mode}</span>
                <span className={`badge ${chat.enabled ? 'enabled' : 'disabled'}`}>
                  {chat.enabled ? 'Включён' : 'Выключен'}
                </span>
              </div>
              <button className="secondary" onClick={() => setSelected(chat)}>
                Настройки
              </button>
            </article>
          ))
        ) : (
          <div className="empty">Чатов пока нет.</div>
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
      {selected && (
        <ChatEditor
          chat={selected}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            void load().catch((error: Error) => onError(error.message));
          }}
          onError={onError}
        />
      )}
    </>
  );
}

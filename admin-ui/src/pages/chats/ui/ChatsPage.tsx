import { useEffect, useState, type FormEvent } from 'react';
import type { Chat } from '../../../entities/chat/model/types';
import { ChatEditor } from '../../../features/chat-config/ui/ChatEditor';
import { request } from '../../../shared/api/client';

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

  async function load(more = false) {
    const result = await request<{ items: Chat[]; nextCursor: string | null }>(
      `/api/chats?limit=20${more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    setChats(more ? (previous) => [...previous, ...result.items] : result.items);
    setCursor(result.nextCursor);
  }

  useEffect(() => {
    void load().catch((error: Error) => onError(error.message));
  }, [reload]);

  async function add(event: FormEvent) {
    event.preventDefault();
    try {
      const chat = await request<Chat>('/api/chats', {
        method: 'POST',
        body: { chatId: newId.trim() },
      });
      setNewId('');
      await load();
      setSelected(chat);
    } catch (error) {
      onError((error as Error).message);
    }
  }

  return (
    <>
      <header className="page-heading">
        <p className="eyebrow">КОНФИГУРАЦИЯ / ЧАТЫ</p>
        <h1>Разрешённые чаты</h1>
        <p className="muted">У каждого чата свой режим, лимиты и системная инструкция.</p>
      </header>
      <form className="add-panel" onSubmit={(event) => void add(event)}>
        <label>
          Добавить по Telegram ID
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
                <h3>Чат {chat.chatId}</h3>
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

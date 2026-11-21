import { useState } from 'react';
import { LoginForm } from '../features/auth/ui/LoginForm';
import { signOut, token } from '../shared/auth/session';
import { OverviewPage } from '../pages/overview/ui/OverviewPage';
import { ChatsPage } from '../pages/chats/ui/ChatsPage';
import { DraftsPage } from '../pages/drafts/ui/DraftsPage';
import { SendsPage } from '../pages/sends/ui/SendsPage';

type View = 'overview' | 'chats' | 'drafts' | 'sends';
const labels: Record<View, string> = {
  overview: 'Обзор',
  chats: 'Чаты',
  drafts: 'Черновики',
  sends: 'Отправки',
};

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [view, setView] = useState<View>('overview');
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');

  function handleError(message: string) {
    setError(message);
    if (!token()) setAuthenticated(false);
  }

  function logout() {
    signOut();
    setAuthenticated(false);
    setView('overview');
    setError('');
  }

  if (!authenticated)
    return (
      <LoginForm
        onSuccess={() => {
          setAuthenticated(true);
          setError('');
        }}
      />
    );

  const props = { reload, onError: handleError };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">✦</span>
          <span>
            <strong>REPLIER</strong>
            <small>CONTROL ROOM</small>
          </span>
        </div>
        <p className="sidebar-label">РАБОЧАЯ ОБЛАСТЬ</p>
        <nav aria-label="Разделы">
          {(Object.keys(labels) as View[]).map((item) => (
            <button
              key={item}
              className={`nav-item ${view === item ? 'active' : ''}`}
              onClick={() => {
                setView(item);
                setError('');
              }}
            >
              <span className="nav-symbol" aria-hidden="true">
                {
                  ({ overview: '◫', chats: '▤', drafts: '✎', sends: '◉' } as Record<View, string>)[
                    item
                  ]
                }
              </span>
              {labels[item]}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="connection">
            <i /> Подключено
          </span>
          <button className="logout" onClick={logout}>
            Выйти
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <span>
            TELEGRAM AI REPLIER <b>/</b> АДМИНИСТРИРОВАНИЕ
          </span>
          <button
            className="secondary"
            onClick={() => {
              setReload((value) => value + 1);
              setError('');
            }}
          >
            Обновить данные
          </button>
        </div>
        <div className="content">
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button onClick={() => setError('')} aria-label="Скрыть ошибку">
                ×
              </button>
            </div>
          )}
          {view === 'overview' && <OverviewPage {...props} />}
          {view === 'chats' && <ChatsPage {...props} />}
          {view === 'drafts' && <DraftsPage {...props} />}
          {view === 'sends' && <SendsPage {...props} />}
        </div>
      </main>
    </div>
  );
}

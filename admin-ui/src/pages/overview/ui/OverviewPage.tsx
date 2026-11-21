import { useEffect, useState } from 'react';
import { request } from '../../../shared/api/client';

interface Status {
  paused: boolean;
  autoreplyEnabled: boolean;
  pendingOutbox: number;
  unknownSends: number;
}
interface Usage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: string | null;
}

export function OverviewPage({
  reload,
  onError,
}: {
  reload: number;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [nextStatus, nextUsage] = await Promise.all([
      request<Status>('/api/status'),
      request<Usage>('/api/usage'),
    ]);
    setStatus(nextStatus);
    setUsage(nextUsage);
  }

  useEffect(() => {
    void load().catch((error: Error) => onError(error.message));
  }, [reload]);

  async function setPause(paused: boolean) {
    if (
      !confirm(
        paused
          ? 'Поставить все ответы на паузу?'
          : 'Снять глобальную паузу? Проверьте настройки чатов.',
      )
    )
      return;
    setBusy(true);
    try {
      await request(`/api/system/${paused ? 'pause' : 'resume'}`, { method: 'POST' });
      await load();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="page-heading">
        <p className="eyebrow">СИСТЕМА / ОБЗОР</p>
        <h1>Состояние репляера</h1>
        <p className="muted">Основные показатели и глобальное управление.</p>
      </header>
      <section className="hero">
        <div>
          <p className="eyebrow">ОБЩИЙ РЕЖИМ</p>
          <h2>{status ? (status.paused ? 'Ответы на паузе' : 'Пауза снята') : 'Загрузка…'}</h2>
          <p>
            {status?.autoreplyEnabled
              ? 'Флаг AUTO в окружении включён.'
              : 'Флаг AUTO в окружении выключен.'}
          </p>
        </div>
        {status && (
          <button
            className={status.paused ? 'primary' : 'danger'}
            disabled={busy}
            onClick={() => void setPause(!status.paused)}
          >
            {status.paused ? 'Снять с паузы' : 'Поставить на паузу'}
          </button>
        )}
      </section>
      <div className="stats">
        <article className="stat">
          <span>Флаг AUTO</span>
          <strong>{status?.autoreplyEnabled ? 'Включён' : 'Выключен'}</strong>
          <small>Задаётся на сервере</small>
        </article>
        <article className="stat">
          <span>Задачи в очереди</span>
          <strong>{status?.pendingOutbox ?? '—'}</strong>
          <small>Не опубликованы в Redis</small>
        </article>
        <article className="stat">
          <span>Неясные отправки</span>
          <strong>{status?.unknownSends ?? '—'}</strong>
          <small>Нужна ручная сверка</small>
        </article>
      </div>
      <h2 className="section-title">Использование модели</h2>
      <div className="stats usage-stats">
        <article className="stat">
          <span>Запросы</span>
          <strong>{usage?.requests ?? '—'}</strong>
        </article>
        <article className="stat">
          <span>Входящие токены</span>
          <strong>{usage?.inputTokens.toLocaleString('ru-RU') ?? '—'}</strong>
        </article>
        <article className="stat">
          <span>Исходящие токены</span>
          <strong>{usage?.outputTokens.toLocaleString('ru-RU') ?? '—'}</strong>
        </article>
        <article className="stat">
          <span>Оценка стоимости</span>
          <strong>
            {usage?.estimatedCostUsd == null
              ? '—'
              : `$${Number(usage.estimatedCostUsd).toFixed(4)}`}
          </strong>
        </article>
      </div>
    </>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { request } from '../../../shared/api/client';

interface Profile {
  name: string;
  about: string;
  work: string;
  interests: string;
  style: string;
  boundaries: string;
  updatedAt: string | null;
}

const empty: Profile = {
  name: '',
  about: '',
  work: '',
  interests: '',
  style: '',
  boundaries: 'Не раскрывать секреты и личные сведения собеседников.',
  updatedAt: null,
};

export function ProfilePage({
  reload,
  onError,
}: {
  reload: number;
  onError: (message: string) => void;
}) {
  const [profile, setProfile] = useState<Profile>(empty);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void request<Profile>('/api/profile')
      .then(setProfile)
      .catch((error: Error) => onError(error.message));
  }, [reload]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    try {
      const result = await request<Profile>('/api/profile', {
        method: 'PUT',
        body: {
          name: profile.name,
          about: profile.about,
          work: profile.work,
          interests: profile.interests,
          style: profile.style,
          boundaries: profile.boundaries,
        },
      });
      setProfile(result);
      setSaved(true);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="page-heading">
        <p className="eyebrow">ПЕРСОНАЛЬНАЯ ПАМЯТЬ / АНКЕТА</p>
        <h1>О тебе</h1>
        <p className="muted">
          Ответы дополняют поиск по твоим исходящим сообщениям. Заполни только то, что можно
          использовать во всех чатах.
        </p>
      </header>
      <form className="profile-form" onSubmit={(event) => void save(event)}>
        <label>
          Как тебя называть?
          <input
            maxLength={200}
            value={profile.name}
            onChange={(event) => setProfile({ ...profile, name: event.target.value })}
          />
        </label>
        <label>
          Что важно знать о тебе?
          <textarea
            rows={4}
            maxLength={4000}
            value={profile.about}
            onChange={(event) => setProfile({ ...profile, about: event.target.value })}
          />
        </label>
        <label>
          Чем ты занимаешься?
          <textarea
            rows={3}
            maxLength={2000}
            value={profile.work}
            onChange={(event) => setProfile({ ...profile, work: event.target.value })}
          />
        </label>
        <label>
          Какие у тебя интересы и привычки?
          <textarea
            rows={3}
            maxLength={2000}
            value={profile.interests}
            onChange={(event) => setProfile({ ...profile, interests: event.target.value })}
          />
        </label>
        <label>
          Как ты обычно пишешь и чего избегать в ответах?
          <textarea
            rows={4}
            maxLength={2000}
            value={profile.style}
            onChange={(event) => setProfile({ ...profile, style: event.target.value })}
            placeholder="Можно оставить пустым: репляер подберёт примеры твоих сообщений из индекса."
          />
        </label>
        <label>
          Какие темы и сведения нельзя переносить между чатами?
          <textarea
            rows={3}
            maxLength={2000}
            value={profile.boundaries}
            onChange={(event) => setProfile({ ...profile, boundaries: event.target.value })}
          />
        </label>
        <div className="profile-actions">
          <span className="small-muted">
            {saved
              ? 'Сохранено'
              : profile.updatedAt
                ? `Обновлено: ${new Date(profile.updatedAt).toLocaleString('ru-RU')}`
                : 'Анкета ещё не заполнена'}
          </span>
          <button className="primary" disabled={busy}>
            {busy ? 'Сохраняю…' : 'Сохранить анкету'}
          </button>
        </div>
      </form>
    </>
  );
}

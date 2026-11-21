import { useState, type FormEvent } from 'react';
import { signIn } from '../../../shared/auth/session';

export function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');

    try {
      await signIn(file);
      onSuccess();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ошибка входа');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-icon">✦</div>
        <p className="eyebrow">TELEGRAM REPLIER / ADMIN</p>
        <h1>Управление репляером</h1>
        <p className="muted">
          Выберите приватный ключ администратора. Браузер подпишет одноразовый вызов; файл ключа не
          отправляется на сервер и не сохраняется в браузере.
        </p>
        <label className="file-field">
          Приватный ключ (.pem)
          <input
            type="file"
            accept=".pem"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy || !file}>
          {busy ? 'Проверка…' : 'Войти'}
        </button>
        <p className="small-muted">
          Доступ возможен только с ключом, чей публичный ключ зарегистрирован на сервере.
        </p>
      </form>
    </main>
  );
}

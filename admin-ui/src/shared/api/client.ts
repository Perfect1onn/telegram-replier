import { renew, signOut, token } from '../auth/session';

export async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const send = (jwt: string) =>
    fetch(path, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'omit',
      cache: 'no-store',
    });

  let response = await send(token());

  if (response.status === 401) {
    try {
      response = await send(await renew());
    } catch {
      signOut();
      throw new Error('Сессия завершена. Войдите снова.');
    }
  }

  if (!response.ok) {
    if (response.status === 401) signOut();

    const data: { error?: string } = await response.json().catch(() => ({}));
    throw new Error(
      response.status === 409
        ? 'Конфликт: данные изменились. Обновите страницу и повторите действие.'
        : (data.error ?? `Ошибка ${response.status}`),
    );
  }

  return response.json() as Promise<T>;
}

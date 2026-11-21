let privateKey: CryptoKey | null = null;
let accessToken = '';

function decodePrivateKey(pem: string): Uint8Array {
  const match = pem.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);

  if (!match?.[1]) throw new Error('Выберите приватный ключ в формате PKCS#8 PEM');

  const binary = atob(match[1].replace(/\s/g, ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function challengeLogin(key: CryptoKey): Promise<string> {
  const challengeResponse = await fetch('/auth/challenge', { method: 'POST', cache: 'no-store' });

  if (!challengeResponse.ok) throw new Error('Не удалось получить одноразовый вызов');

  const challenge: { id: string; message: string } = await challengeResponse.json();
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(challenge.message),
    ),
  );
  const base64url = btoa(String.fromCharCode(...signature))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const response = await fetch('/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: challenge.id, signature: base64url }),
    cache: 'no-store',
  });

  if (!response.ok) throw new Error('Ключ не авторизован или подпись не прошла проверку');

  const result: { token: string } = await response.json();
  return result.token;
}

export async function signIn(file: File): Promise<void> {
  if (file.size > 16_384) throw new Error('Файл ключа слишком большой');

  const bytes = decodePrivateKey(await file.text());
  const key = await crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  accessToken = await challengeLogin(key);
  privateKey = key;
}

export async function renew(): Promise<string> {
  if (!privateKey) throw new Error('Сессия завершена. Выберите приватный ключ снова.');

  accessToken = await challengeLogin(privateKey);
  return accessToken;
}

export function token(): string {
  return accessToken;
}

export function signOut(): void {
  accessToken = '';
  privateKey = null;
}

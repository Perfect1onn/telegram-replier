import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { Logger } from 'teleproto/extensions';
import { writeSessionFile } from '../src/infrastructure/security/session-file.ts';

async function login(): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('Interactive terminal required');

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH ?? '';

  if (!Number.isSafeInteger(apiId) || apiId < 1 || !/^[a-f\d]{32}$/i.test(apiHash))
    throw new Error('Invalid Telegram configuration');

  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const input = createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
    historySize: 0,
  });
  const question = async (prompt: string): Promise<string> => {
    process.stdout.write(prompt);

    const value = await input.question('');

    process.stdout.write('\n');

    return value;
  };
  const logger = new Logger();

  logger.handler = () => {};

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    baseLogger: logger,
    connectionRetries: 3,
    requestRetries: 1,
  });

  try {
    await client.start({
      phoneNumber: () => question('Phone (hidden): '),
      phoneCode: () => question('Code (hidden): '),
      password: () => question('2FA password (hidden): '),
      onError: () => {
        throw new Error('Telegram authorization failed');
      },
    });

    const session = client.session.save();

    if (typeof session !== 'string' || !session) throw new Error('Session was not created');

    await writeSessionFile(process.env.TELEGRAM_SESSION_FILE ?? '.telegram-session', session);
    process.stdout.write('Session saved with private permissions.\n');
  } finally {
    input.close();
    await client.disconnect();
  }
}

try {
  await login();
} catch {
  process.stderr.write(
    'Login failed. Check credentials and network; sensitive error details suppressed.\n',
  );
  process.exitCode = 1;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '../../src/config/env.ts';
import {
  readSessionFile,
  writeSessionFile,
} from '../../src/infrastructure/security/session-file.ts';

const env = {
  ADMIN_JWT_SECRET: 'a'.repeat(64),
  ADMIN_PUBLIC_KEY_FILE: '.admin-public.pem',
  TELEGRAM_API_ID: '1',
  TELEGRAM_API_HASH: 'a'.repeat(32),
  TELEGRAM_EXPECTED_ACCOUNT_ID: '123',
  OPENAI_API_KEY: 'sensitive-key',
  OPENAI_MODEL: 'configured-model',
  OPENAI_EMBEDDING_MODEL: 'configured-embedding',
  DATABASE_URL: 'postgresql://localhost/test',
  REDIS_URL: 'redis://localhost',
};

test('config is immutable, paused by default and does not invent models', () => {
  const config = loadSettings(env);

  assert.equal(config.autoreplyEnabled, false);
  assert.ok(Object.isFrozen(config));
  assert.equal(config.model, env.OPENAI_MODEL);
});
test('reject unsafe config without exposing values', () => {
  for (const patch of [
    { ADMIN_HOST: '0.0.0.0' },
    { ADMIN_JWT_SECRET: 'replace-me' },
    { AUTOREPLY_ENABLED: 'yes' },
    { WORKER_CONCURRENCY: '999' },
    { DATABASE_URL: 'https://private-secret' },
    { TELEGRAM_API_ID: '-1' },
  ]) {
    assert.throws(
      () => loadSettings({ ...env, ...patch }),
      (error) => error instanceof Error && !error.message.includes('private-secret'),
    );
  }
});
test('session file atomic persistence, permissions and symlink protection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'replier-session-'));
  const path = join(directory, 'session');

  try {
    await writeSessionFile(path, 'test-session');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readSessionFile(path), 'test-session');
    await symlink(path, join(directory, 'link'));
    await assert.rejects(readSessionFile(join(directory, 'link')));
    await chmod(path, 0o644);
    await assert.rejects(readSessionFile(path));
    await assert.rejects(writeSessionFile(path, ''));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

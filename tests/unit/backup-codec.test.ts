import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  backupKey,
  decryptBackupToTemporaryFile,
  encryptBackup,
} from '../../src/infrastructure/security/backup-codec.ts';

test('backup encryption round trips and rejects tampering before restore', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-replier-backup-test-'));
  const path = join(directory, 'data.trbk');
  const key = randomBytes(32);
  const plaintext = Buffer.from('private database text 😀'.repeat(1000));

  try {
    assert.deepEqual(backupKey(key.toString('base64')), key);
    await encryptBackup(
      (async function* () {
        yield plaintext;
      })(),
      path,
      key,
    );

    assert.equal((await stat(path)).mode & 0o777, 0o600);

    const temporary = await decryptBackupToTemporaryFile(path, key);

    try {
      assert.deepEqual(await readFile(temporary.path), plaintext);
    } finally {
      await temporary.cleanup();
    }

    const damaged = await readFile(path);

    damaged[20] = (damaged[20] ?? 0) ^ 1;
    await writeFile(path, damaged);
    await assert.rejects(decryptBackupToTemporaryFile(path, key));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

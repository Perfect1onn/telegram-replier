import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import {
  backupKey,
  decryptBackupToTemporaryFile,
} from '../src/infrastructure/security/backup-codec.ts';

const path = process.argv[2];

if (!path || process.env.RESTORE_CONFIRM !== 'RESTORE_TO_EMPTY_DATABASE')
  throw new Error('Restore file and explicit confirmation required');

const temporary = await decryptBackupToTemporaryFile(
  path,
  backupKey(process.env.BACKUP_KEY_BASE64),
);

try {
  for await (const chunk of createReadStream(temporary.path))
    if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
} finally {
  await temporary.cleanup();
}

import { backupKey, encryptBackup } from '../src/infrastructure/security/backup-codec.ts';

const path = process.argv[2];

if (!path) throw new Error('Backup output path required');

await encryptBackup(process.stdin, path, backupKey(process.env.BACKUP_KEY_BASE64));

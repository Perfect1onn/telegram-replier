import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const prefix = process.argv[2] ?? '.admin-auth';

if (!/^[\w./-]+$/.test(prefix) || prefix.includes('..'))
  throw new Error('Use a simple output path');

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privatePath = `${prefix}.private.pem`;
const publicPath = `${prefix}.public.pem`;

await writeFile(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
  flag: 'wx',
  mode: 0o600,
});
await writeFile(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), {
  flag: 'wx',
  mode: 0o644,
});

process.stdout.write(`Private key: ${privatePath}\nPublic key: ${publicPath}\n`);

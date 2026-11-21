import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAGIC = Buffer.from('TRBK1');
const IV_SIZE = 12;
const TAG_SIZE = 16;

export function backupKey(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid backup key');

  const key = Buffer.from(value, 'base64');

  if (key.length !== 32) throw new Error('Invalid backup key');

  return key;
}

async function writeAll(file: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;

  while (offset < data.length) {
    const result = await file.write(data, offset, data.length - offset);

    if (!result.bytesWritten) throw new Error('Backup write failed');

    offset += result.bytesWritten;
  }
}

export async function encryptBackup(
  input: AsyncIterable<Buffer>,
  path: string,
  key: Buffer,
): Promise<void> {
  if (key.length !== 32) throw new Error('Invalid backup key');

  const iv = randomBytes(IV_SIZE);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const file = await open(path, 'wx', 0o600);
  let complete = false;

  try {
    await writeAll(file, Buffer.concat([MAGIC, iv]));

    for await (const chunk of input) await writeAll(file, cipher.update(chunk));

    await writeAll(file, cipher.final());
    await writeAll(file, cipher.getAuthTag());
    await file.sync();
    complete = true;
  } finally {
    await file.close();

    if (!complete) await unlink(path).catch(() => {});
  }
}

export async function decryptBackupToTemporaryFile(
  path: string,
  key: Buffer,
): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  if (key.length !== 32) throw new Error('Invalid backup key');

  const source = await open(path, 'r');

  try {
    const info = await source.stat();

    if (info.size < MAGIC.length + IV_SIZE + TAG_SIZE) throw new Error('Invalid backup file');

    const header = Buffer.alloc(MAGIC.length + IV_SIZE);
    const tag = Buffer.alloc(TAG_SIZE);
    const headerRead = await source.read(header, 0, header.length, 0);
    const tagRead = await source.read(tag, 0, tag.length, info.size - TAG_SIZE);

    if (
      headerRead.bytesRead !== header.length ||
      tagRead.bytesRead !== tag.length ||
      !header.subarray(0, MAGIC.length).equals(MAGIC)
    )
      throw new Error('Invalid backup file');

    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));

    decipher.setAuthTag(tag);

    const temporaryPath = join(tmpdir(), `telegram-replier-restore-${randomUUID()}`);
    const output = await open(temporaryPath, 'wx', 0o600);
    let complete = false;

    try {
      let position = header.length;
      const end = info.size - TAG_SIZE;
      const buffer = Buffer.alloc(64 * 1024);

      while (position < end) {
        const { bytesRead } = await source.read(
          buffer,
          0,
          Math.min(buffer.length, end - position),
          position,
        );

        if (!bytesRead) throw new Error('Invalid backup file');

        await writeAll(output, decipher.update(buffer.subarray(0, bytesRead)));
        position += bytesRead;
      }

      await writeAll(output, decipher.final());
      await output.sync();
      complete = true;
    } finally {
      await output.close();

      if (!complete) await unlink(temporaryPath).catch(() => {});
    }

    return { path: temporaryPath, cleanup: () => unlink(temporaryPath) };
  } finally {
    await source.close();
  }
}

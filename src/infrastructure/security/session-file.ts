import { open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

export async function readSessionFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const info = await file.stat();

    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 65536 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error('Unsafe session file');

    const session = (await file.readFile('utf8')).trim();

    if (!session) throw new Error('Empty session file');

    return session;
  } finally {
    await file.close();
  }
}

export async function writeSessionFile(path: string, session: string): Promise<void> {
  if (!session.trim() || Buffer.byteLength(session) > 65536) throw new Error('Invalid session');

  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);

  try {
    await file.writeFile(session, 'utf8');
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(temporary);

    throw error;
  }

  await file.close();

  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary);

    throw error;
  }
}

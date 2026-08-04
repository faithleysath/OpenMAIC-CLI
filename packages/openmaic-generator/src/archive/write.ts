import { access, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { nanoid } from 'nanoid';
import { OpenMaicError, throwIfAborted } from '../errors.js';

export async function writeAtomicFile(
  path: string,
  data: Buffer,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  throwIfAborted(options.signal);
  await mkdir(dirname(path), { recursive: true });
  if (!options.force) {
    try {
      await access(path);
      throw new OpenMaicError(
        'ARCHIVE_ERROR',
        `Output already exists: ${path}. Use --force to replace it.`,
      );
    } catch (error) {
      if (error instanceof OpenMaicError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${nanoid(8)}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfAborted(options.signal);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

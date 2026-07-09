// Mock storage: plain filesystem under STORAGE_DIR (default apps/api/uploads,
// gitignored). Keys map 1:1 to relative paths; `..` segments are rejected so a
// key can never escape the base directory.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StorageAdapter } from '../types';

// Resolved per call (not at import time) so tests can point STORAGE_DIR at a
// temp dir before exercising the adapter.
function baseDir(): string {
  return process.env.STORAGE_DIR ?? path.resolve('uploads');
}

function resolveKey(key: string): string {
  if (key.split(/[/\\]/).includes('..')) {
    throw new Error(`[mock-storage] invalid storage key (path traversal): ${key}`);
  }
  return path.join(baseDir(), key);
}

export const mockStorage: StorageAdapter = {
  async put(key, data) {
    const filePath = resolveKey(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
  },

  async get(key) {
    try {
      return await readFile(resolveKey(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },

  async delete(key) {
    await rm(resolveKey(key), { force: true });
  },
};

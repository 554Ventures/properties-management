// Device-local key/value with an in-memory fallback, mirroring lib/consent.ts:
// localStorage can be unavailable or throwing (some test environments, strict
// privacy modes). In the iOS shell it's always real, so native prefs persist.
const memory = new Map<string, string>();

function getStorage(): Storage | null {
  try {
    // The getter itself can throw; and in some Node/test setups
    // window.localStorage is undefined rather than a Storage.
    return typeof window !== 'undefined' ? (window.localStorage ?? null) : null;
  } catch {
    return null;
  }
}

export function readLocal(key: string): string | null {
  const storage = getStorage();
  if (!storage) return memory.get(key) ?? null;
  try {
    return storage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

export function writeLocal(key: string, value: string): void {
  const storage = getStorage();
  if (!storage) {
    memory.set(key, value);
    return;
  }
  try {
    storage.setItem(key, value);
  } catch {
    memory.set(key, value);
  }
}

export function removeLocal(key: string): void {
  memory.delete(key);
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Nothing to clean up if storage isn't available.
  }
}

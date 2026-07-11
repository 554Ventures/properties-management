// Face ID lock preference + authentication. The preference is device-local
// (localStorage), not account state — locking is a property of this phone.
import { isNativeApp } from './platform';
import { readLocal, removeLocal, writeLocal } from './storage';

const PREF_KEY = 'hearth.biometricLock';

export function isBiometricLockEnabled(): boolean {
  return readLocal(PREF_KEY) === 'true';
}

export function setBiometricLockEnabled(enabled: boolean): void {
  if (enabled) writeLocal(PREF_KEY, 'true');
  else removeLocal(PREF_KEY);
}

/**
 * Run the native biometric prompt (Face ID / passcode fallback). Resolves
 * false on failure/cancel/bridge-skew — callers decide whether that means
 * "stay locked" (gate) or "don't enable the lock" (settings toggle).
 */
export async function authenticateBiometric(reason: string): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
    await BiometricAuth.authenticate({ reason, allowDeviceCredential: true });
    return true;
  } catch {
    return false;
  }
}

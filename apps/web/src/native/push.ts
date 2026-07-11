// Push registration for the iOS shell. Runs on every launch — the backend's
// register is an upsert, so re-registering is idempotent and doubles as a
// lastSeenAt heartbeat. The token is cached locally so sign-out can delete the
// device row before the session (and its bearer token) goes away.
//
// Every plugin call is wrapped so a bridge/version skew (shell older than the
// deployed web bundle) degrades to "push stays off", never a crash.
import { api } from '../api/client';
import { isNativeApp } from './platform';
import { readLocal, removeLocal, writeLocal } from './storage';

const TOKEN_STORAGE_KEY = 'hearth.pushToken';

/** The device token cached by the last successful registration (if any). */
export function getCachedPushToken(): string | null {
  return readLocal(TOKEN_STORAGE_KEY);
}

/**
 * Ask for permission, register with APNs, and upsert the device row. Deep-link
 * taps (`data.deepLink` from the APNs payload) navigate via `onDeepLink`.
 */
export async function initPushRegistration(onDeepLink: (path: string) => void): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    await PushNotifications.addListener('registration', (token) => {
      void (async () => {
        try {
          await api.post('/devices', { platform: 'ios', token: token.value });
          writeLocal(TOKEN_STORAGE_KEY, token.value);
        } catch {
          // Offline or API hiccup — the next launch re-registers.
        }
      })();
    });

    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const data = action.notification.data as { deepLink?: unknown } | undefined;
      const deepLink = data?.deepLink;
      // In-app routes only — never navigate to an absolute URL from a payload.
      if (typeof deepLink === 'string' && deepLink.startsWith('/')) onDeepLink(deepLink);
    });

    let permission = await PushNotifications.checkPermissions();
    if (permission.receive === 'prompt') {
      permission = await PushNotifications.requestPermissions();
    }
    if (permission.receive !== 'granted') return;
    await PushNotifications.register();
  } catch {
    // Version skew or simulator without push entitlement — push stays off.
  }
}

/** Re-runs the permission prompt + registration (Settings' re-enable affordance). */
export async function reenablePush(onDeepLink: (path: string) => void): Promise<void> {
  await initPushRegistration(onDeepLink);
}

/**
 * Delete this device's row so a signed-out phone stops receiving pushes.
 * Called from auth signOut BEFORE the Supabase session is cleared (the DELETE
 * still needs the bearer token).
 */
export async function unregisterPush(): Promise<void> {
  if (!isNativeApp()) return;
  try {
    const token = readLocal(TOKEN_STORAGE_KEY);
    if (!token) return;
    await api.delete(`/devices/${encodeURIComponent(token)}`);
    removeLocal(TOKEN_STORAGE_KEY);
  } catch {
    // Best-effort: an unreachable API shouldn't block sign-out. The row is
    // reassigned on the next sign-in's re-register anyway.
  }
}

// The one static Capacitor import in the web app (tiny and browser-safe).
// Everything else under src/native/ loads plugins with dynamic import() behind
// this check, so plain-browser bundles code-split them out and never execute
// plugin paths.
import { Capacitor } from '@capacitor/core';

/** True when running inside the iOS Capacitor shell (docs/MOBILE.md). */
export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

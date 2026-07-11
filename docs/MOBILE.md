# Mobile — iOS Capacitor shell (Phase 2)

> Shipped from [mobile-phase2-plan.md](mobile-phase2-plan.md) on 2026-07-11. iOS only, personal use (Xcode/TestFlight installs).

## Architecture

**Remote-URL shell.** `apps/mobile` is a Capacitor 8 wrapper whose WKWebView loads **https://app.554properties.com directly** (`capacitor.config.ts` → `server.url`). Consequences:

- Every web deploy updates the installed app instantly — there is no app-release step for web changes.
- API calls stay same-origin (no CORS or API-base changes); Supabase JWTs and the fetch+ReadableStream SSE chat work unchanged in WKWebView.
- The shell only needs rebuilding when a `@capacitor/*` version changes (see version-skew policy) or native config (Info.plist, entitlements) changes.

**Bundle ID is `com.properties554.hearth`** — the plan's `com.554properties.hearth` is valid for Apple but rejected by the Capacitor CLI (Java-package rules: segments can't start with a digit). Register exactly `com.properties554.hearth` with Apple and use it for `APNS_BUNDLE_ID`.

**Native features** live in `apps/web/src/native/` and ride inside the deployed web bundle:

| File | What |
|---|---|
| `platform.ts` | `isNativeApp()` — the only static Capacitor import; everything else dynamic-imports plugins behind it, so plain-browser bundles code-split them out |
| `push.ts` | permission → APNs registration → `POST /devices` upsert (every launch; idempotent); deep-link taps navigate to `data.deepLink` (in-app routes only); `unregisterPush()` runs in signOut before the session is cleared |
| `camera.ts` | `capturePhoto()` → File → the existing receipt-scan path (no backend change) |
| `biometric.ts` + `BiometricGate.tsx` | Face ID lock (device-local pref `hearth.biometricLock`); auto-attempt on mount, visible-text retry, re-lock on `appStateChange` inactive |
| `NativeBridge.tsx` | null-rendering mount point inside `AuthGate` (router.tsx) |
| `storage.ts` | localStorage with in-memory fallback (mirrors `lib/consent.ts`) |

Settings gains an iOS-only "Mobile app" card (Face ID toggle — enabling authenticates first so you can't lock yourself out — and push status from `GET /devices` with a re-enable button). In the shell, the Supabase session store is backed by `@capacitor/preferences` (native UserDefaults) so WKWebView storage eviction can't sign you out.

**Push backend**: `PushDevice` model (account-scoped, token-unique), `POST/GET/DELETE /api/v1/devices`, `push.service.notifyAccount()` (never throws; prunes tokens APNs reports unregistered). Triggers: rent payment recorded → "Rent received"; daily 9am cron → each *newly created* `warning` insight. Adapter: `integrations/real/real-apns.ts` — ES256 provider JWT via `jose` (cached ~50 min) + raw `node:http2`; mock provider (`integrations/mock/mock-push.ts`) whenever `APNS_*` env is incomplete.

## Version-skew policy (binding)

The shell's plugin **native code** is compiled in at build time; the **JS side** ships with the web deploy. To keep the injected bridge and the deployed JS compatible:

- `@capacitor/*` + biometric plugin versions are **exact-pinned and identical** in `apps/web/package.json` and `apps/mobile/package.json`. Bump them together, in one commit.
- After any Capacitor bump: `npm run sync -w apps/mobile`, rebuild in Xcode, reinstall on the phone.
- Every native call in `src/native/` is wrapped in try/catch no-ops, so an old shell against new web JS degrades (feature off) instead of crashing.

## APNs environment (read this before pruning devices)

`APNS_ENV` **must match the install channel**: `sandbox` for Xcode-run installs, `production` for TestFlight/App Store. A mismatch makes APNs return `BadDeviceToken`, which the backend treats as "device gone" and **deletes valid device rows**. Pick one install channel per environment and stick to it.

All five env vars (`APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY` — the `.p8` PEM with `\n`-escaped newlines, `APNS_BUNDLE_ID`, `APNS_ENV`) must be set or the API silently uses the mock push provider. Locally they go in `apps/api/.env`; in production they are Worker secrets forwarded to the container (`deploy/worker.ts`).

## Dev workflow

```bash
npm run typecheck -w apps/mobile          # config typecheck (no build/test scripts — CI skips this workspace)
npm run sync -w apps/mobile               # cap sync ios (after plugin/config changes)
npm run open -w apps/mobile               # open in Xcode
npm run ios -w apps/mobile                # build + run on simulator/device
```

Point the shell at a local Vite instead of production:

```bash
npm run dev                                   # api + web + db
npm run dev -w apps/web -- --host             # expose Vite on the LAN
CAP_SERVER_URL=http://<lan-ip>:5173 npm run sync -w apps/mobile   # then run from Xcode
```

(`CAP_SERVER_URL` enables `cleartext` for plain-http LAN; re-run plain `npm run sync -w apps/mobile` to point back at production.)

Building from a headless shell (CI, agents): pass `-scmProvider system` to `xcodebuild` — Xcode's built-in SCM can hang indefinitely resolving the SPM packages outside a GUI session; system git resolves them in seconds. Xcode itself is unaffected.

Simulator: Features → Face ID → Enrolled to test the gate; camera needs a real device; push needs a real device + APNs setup below.

## Apple setup checklist (manual, one-time)

1. developer.apple.com → Certificates, Identifiers & Profiles → **Identifiers**: register `com.properties554.hearth` with the **Push Notifications** capability.
2. **Keys**: create an APNs Auth Key; download the `.p8` (one-time download — keep it safe), note the **Key ID** and your **Team ID**.
3. Xcode (`npm run open -w apps/mobile`): set the Signing Team on the App target; add the **Push Notifications** capability.
4. Secrets: `npx wrangler secret put` each of `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID`, `APNS_ENV`; record them in `.secrets.local`.
5. Install: Xcode run to your device (`APNS_ENV=sandbox`) **or** TestFlight internal (`APNS_ENV=production`) — not both against one backend.
6. First launch: sign in, accept the push prompt, then confirm a device row exists via `GET /api/v1/devices`.
7. End-to-end: record a rent payment in the web app → "Rent received" lands on the phone. Cron path: `curl -X POST -H "x-cron-secret: $CRON_SECRET" https://app.554properties.com/api/v1/internal/run-daily-jobs`.

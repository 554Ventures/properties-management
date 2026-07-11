# Phase 2 — Hearth iOS App (Capacitor remote-URL shell + push, camera, Face ID)

> **Status: implemented 2026-07-11** — see [MOBILE.md](MOBILE.md), which now governs the mobile architecture. This file is kept as the planning record. Deviations from plan: bundle id is `com.properties554.hearth` (the Capacitor CLI rejects digit-leading segments the plan assumed Apple-valid), the iOS project uses SPM instead of CocoaPods, and adapter selection lives in `integrations/factory.ts` (repo convention) rather than a new `integrations/push.ts`. Part D (manual Apple steps) remains open — checklist in MOBILE.md.
>
> Original planning header: planned 2026-07-04. Decisions locked with the user: Capacitor wrap, iOS only, remote-URL shell, personal use (paid Apple Developer account), push + camera + Face ID.


## Context

v1 web is live at https://app.554properties.com and the responsive UI already covers the wireframes' mobile layouts (bottom tab bar, safe-area insets, full-screen chat). Phase 2 adds a real installable iOS app. Decisions made with the user:

- **Capacitor wrap** of the existing React web app (not React Native), **iOS only**, **personal use** (Xcode/TestFlight installs; paid Apple Developer account available).
- **Remote-URL shell mode**: the native shell loads https://app.554properties.com directly — every web deploy updates the app instantly; no CORS or API-base changes (same-origin preserved); the shell only needs rebuilding when `@capacitor/*` versions change.
- **Native capabilities:** push notifications (landlord alerts), camera receipt capture, Face ID unlock.
- Full app functionality rides along free; no feature-removal work for the "on-the-go subset" emphasis.

Backend is already mobile-ready (Supabase JWTs are transport-agnostic Bearer tokens; `fetch`+`ReadableStream` SSE works in WKWebView unchanged). The only greenfield backend work is **push** — no device/token modeling exists anywhere.

**Library choices:** Capacitor 8 (`@capacitor/core|cli|ios|app|camera|push-notifications|preferences`, exact-pinned identically in `apps/web` and `apps/mobile`); biometrics via `@aparajita/capacitor-biometric-auth` (pure authenticate-the-human API + web fallback); APNs adapter hand-rolled with `node:http2` + `jose` (already an api dep — ES256 provider JWT; the `apns2` package would be a new dep for ~100 lines of stable protocol).

---

## Part A — Push backend (contract-first)

### A1. Shared contract (`packages/shared`)
- `src/enums.ts`: `PushPlatformSchema = z.enum(['ios'])` + type, following existing enum pattern.
- New `src/schemas/device.ts`: `PushDeviceSchema` (id, accountId, platform, token, createdAt, lastSeenAt), `RegisterDeviceInputSchema` ({ platform, token: z.string().min(1) }), `PushDeviceListResponseSchema`.
- `src/schemas/api.ts`: re-export; `src/types.ts`: infer aliases. Verify: `npm run typecheck`.

### A2. Prisma model + migration (`apps/api/prisma/schema.prisma`)
```prisma
model PushDevice {
  id         String   @id @default(cuid())
  accountId  String
  platform   String   // PushPlatform (@hearth/shared): ios
  token      String   @unique // APNs device token
  createdAt  DateTime @default(now())
  lastSeenAt DateTime @default(now())
  account Account @relation(fields: [accountId], references: [id], onDelete: Cascade)
  @@index([accountId])
}
```
No `userId` — account is the tenancy boundary, matching every other model. `npx prisma migrate dev --name add_push_device` (dev DB running). Additive — safe for the auto-deploy migrate step.

### A3. PushProvider adapter (integrations pattern)
- `src/integrations/types.ts`: add `PushMessage { title, body, deepLink? }`, `PushSendResult { ok, unregistered?, reason? }`, `PushProvider { send(deviceToken, message) }`.
- `src/integrations/mock/mock-push.ts`: mirrors `mock-email.ts`; records to exported `sentPushes[]` + `resetMockPush()` for test assertions.
- `src/integrations/apns/apns-push.ts`: ES256 provider JWT via `jose` (`importPKCS8` + `SignJWT`, header kid=`APNS_KEY_ID`, iss=`APNS_TEAM_ID`), cached ~50 min; `node:http2` POST `/3/device/{token}` to `api.push.apple.com` or sandbox per `APNS_ENV`; headers `apns-topic=APNS_BUNDLE_ID`, `apns-push-type: alert`, priority 10; map 410/`BadDeviceToken`/`Unregistered` → `{ ok:false, unregistered:true }`.
- `src/integrations/push.ts`: `getPushProvider()` — real adapter only when all `APNS_*` set, else mock (reads env inside the function, mirroring the ANTHROPIC_API_KEY mock-mode switch).
- `.env.example`: `APNS_TEAM_ID / APNS_KEY_ID / APNS_PRIVATE_KEY (PEM, \n-escaped) / APNS_BUNDLE_ID / APNS_ENV=sandbox` — mock mode when unset.

### A4. Service + routes + tests
- `src/services/push.service.ts` (accountId first): `registerDevice` (upsert on token — reassigns account, bumps lastSeenAt; idempotent), `listDevices`, `unregisterDevice` (deleteMany scoped to account), `notifyAccount(accountId, message)` — sends to all account devices, deletes rows on `unregistered`, **never throws** (fire-and-forget; must not fail the triggering write). No AuditLog (not money/tenant-touching; precedent: integration.service.ts).
- `src/routes/devices.ts`: `POST /devices`, `GET /devices`, `DELETE /devices/:token` (204). Register in `app.ts` under `/api/v1`.
- `src/__tests__/devices.test.ts` (follow rent.test.ts structure): parse responses with shared schemas; idempotent re-register; account-scoped delete; `notifyAccount` → `sentPushes`; unregistered result deletes row.

### A5. Trigger wiring (push notifies the landlord; mock email notifies tenants)
1. **Payment received** — `rent.service.ts` `recordPayment()` (after audit writes): `notifyAccount(accountId, { title: 'Rent received', body: '<tenant> paid <formatUsd> for <period>', deepLink: '/rent' })`.
2. **Daily 9am cron** — `jobs.service.ts` `runDailyJobs()` already collects `generateInsights(accountId)` results (line 36 returns newly created insights): push each new insight with `severity === 'warning'` (late rent, expense spike; skips info noise; existing `dedupeKey` machinery prevents repeats). Send `{ title: insight.title, body: insight.body, deepLink: insight.actionTarget ?? '/' }`.
- Tests: seeded device + `POST /rent/payments` → payment push in `sentPushes`; fresh warning insight → push.

### A6. Deployment plumbing
- `deploy/worker.ts`: add the five `APNS_*` vars to `Env` + container `envVars` (like `ANTHROPIC_API_KEY`); `wrangler.jsonc` secrets comment updated.
- Human step: `npx wrangler secret put` each; record in `.secrets.local`. `APNS_ENV` must match install channel (sandbox = Xcode run, production = TestFlight).

---

## Part B — `apps/mobile` workspace (Capacitor shell)

Auto-joins root workspaces glob (`apps/*`). Contents: `package.json` (`@hearth/mobile`, scripts `sync`/`open`/`ios`/`typecheck`; **no build/test scripts** so CI `--if-present` skips it), `capacitor.config.ts`, `tsconfig.json`, placeholder `www/index.html` (cap sync requires webDir), and the committed `ios/` project from `npx cap add ios`.

`capacitor.config.ts`: `appId: 'com.554properties.hearth'` (digit-leading segment valid for Apple bundle IDs), `appName: 'Hearth'`, `webDir: 'www'`, `server.url = process.env.CAP_SERVER_URL || 'https://app.554properties.com'` (`cleartext: true` in the dev branch for LAN Vite). No `allowNavigation` needed — Supabase auth is fetch-based email/password, no OAuth redirects.

`ios/App/App/Info.plist`: `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSFaceIDUsageDescription`.

Add `apps/mobile/ios` + `apps/mobile/www` to `.dockerignore` (API image builds from repo root).

Milestone: simulator build loads the production site end-to-end before any native features land.

---

## Part C — Native integration module in `apps/web`

Remote-URL mode means the **deployed web bundle** must carry `@capacitor/core` + plugin JS for the injected bridge. Add the exact-same-pinned deps to `apps/web/package.json`. All plugin imports are **dynamic** (`await import(...)`) behind `isNativeApp()` so plain-browser bundles code-split them out and never execute plugin paths; every native call wrapped in try/catch no-ops (version-skew guard).

- `src/native/platform.ts`: `isNativeApp()` via static `Capacitor.isNativePlatform()` (tiny, browser-safe).
- `src/native/push.ts`: `initPushRegistration()` — request permission → `register()` → on `registration` event, `api.post('/devices', { platform: 'ios', token })` (reuses `src/api/client.ts`; runs every launch, backend upsert makes it idempotent; token cached in localStorage for logout cleanup). `pushNotificationActionPerformed` listener navigates to `data.deepLink`. `unregisterPush()` called from `state/auth.tsx` `signOut` before `supabase.auth.signOut()`.
- `src/native/NativeBridge.tsx`: null-rendering component mounted inside `AuthGate` in `main.tsx` (session exists); runs push init once; renders `BiometricGate`.
- `src/native/camera.ts` + `pages/AddTransaction.tsx`: `capturePhoto()` via `@capacitor/camera` (Base64 → `File('receipt.jpg')`); "Take a photo" secondary `Button` next to "Choose an image" (`AddTransaction.tsx:157`), shown only when native, feeding the existing `handleFile()` → `useScanReceipt()` → `api.postForm('/transactions/receipt')` path. **No backend change.**
- `src/native/biometric.ts` + `BiometricGate.tsx`: Face ID overlay gating the app when native + enabled (localStorage pref `hearth.biometricLock`); auto-attempt on mount, retry button on failure (visible text, not color-only); re-lock on `@capacitor/app` `appStateChange` inactive; `role="dialog"`, focus-trap conventions, design tokens only.
- `pages/Settings.tsx`: "Mobile app" `Card` rendered only when native — Face ID toggle (enabling runs `authenticate()` first so you can't lock yourself out) + push status from `GET /devices` with re-enable affordance.
- Hardening (own commit): when native, back supabase-js `auth.storage` with `@capacitor/preferences` so sessions survive WKWebView storage eviction.
- Web tests (vitest + jsdom): `vi.mock('@capacitor/core')` — plain web renders none of it; native renders gate + registers device; **axe scan on BiometricGate** (a11y merge-blocking).

---

## Part D — Manual Apple steps (human checklist, kept in docs/MOBILE.md)

1. developer.apple.com → Identifiers: register `com.554properties.hearth` with Push Notifications capability.
2. Keys: create APNs Auth Key, download `.p8` (one-time), note Key ID + Team ID.
3. Xcode (`npm run open -w apps/mobile`): set Signing Team; add Push Notifications capability.
4. `wrangler secret put` the five APNS_* values; record in `.secrets.local`.
5. Install: Xcode run to device (`APNS_ENV=sandbox`) or TestFlight internal (`APNS_ENV=production`).
6. First launch: sign in, accept push prompt, confirm device row via `GET /api/v1/devices`.

## Part E — Docs

New `docs/MOBILE.md` (architecture, version-skew policy, dev workflow via `CAP_SERVER_URL`, Apple checklist, APNS env, sandbox-vs-production warning). Update: `FEATURES.md`, `WHATS_NEXT.md` (§4 native mobile), `ACCOUNT_SETUP.md` (Apple Developer section), root `CLAUDE.md` monorepo sentence, `ARCHITECTURE.md` repo tree.

---

## Verification

| Layer | How |
|---|---|
| Contract + deploy types | `npm run typecheck` (root, includes deploy/) |
| Migration + backend | `npm run test -w apps/api`; `npx vitest run src/__tests__/devices.test.ts` |
| APNs adapter | unit test: throwaway ES256 key, assert JWT header/claims + cache; response mapping via injected http2 seam |
| Web native module | `npm run test -w apps/web` (Capacitor mocked, axe on gate) |
| Shell + Face ID | iOS Simulator (Features → Face ID → Enrolled) against prod URL |
| Camera | real device (simulator has no camera) |
| Push e2e | real device: record rent payment → "Rent received" on phone; cron via `curl POST /api/v1/internal/run-daily-jobs` |
| Local dev loop | `npm run dev` + `npm run dev -w apps/web -- --host`; `CAP_SERVER_URL=http://<lan-ip>:5173 npm run sync -w apps/mobile` |

## Risks

- **Remote-URL bridge/version skew**: identical pinned `@capacitor/*` both sides; try/catch no-op guards; rebuild shell on any Capacitor bump (documented).
- **WKWebView storage eviction** → session/pref loss: Preferences-backed Supabase storage (C hardening); push re-registers each launch.
- **APNS_ENV mismatch** (sandbox vs production) yields BadDeviceToken and would prune valid rows — documented loudly; one install channel.
- **9am cron cold start**: container wakes on cron fetch; `notifyAccount` is awaited within the request — fine.

## Suggested implementation order

A1→A2→A3→A4→A5 (backend, fully testable in vitest) → A6 (deploy plumbing) → B (shell milestone: prod site in simulator) → C (native module + UI) → D (manual Apple steps, on-device verification) → E (docs).

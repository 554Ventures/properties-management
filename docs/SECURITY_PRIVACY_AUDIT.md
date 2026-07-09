# Security & Privacy Audit — 554 Properties (Hearth)

**Date:** 2026-07-09
**Scope:** `apps/api` (Fastify + Prisma/Postgres), `apps/web` (React/Vite), `packages/shared`, deployment config (`wrangler.jsonc`, `deploy/worker.ts`, `.github/workflows/ci.yml`), production at https://app.554properties.com (Cloudflare Worker/Containers + Supabase Postgres + Supabase Auth), AI agent (`apps/api/src/ai/*`, Anthropic Claude).
**Method:** static code review with `file:line` citations (no live penetration test, no exploitation against production), `npm audit` across all three workspaces, and current web research for the legal/compliance section (sources cited inline). This is a **read-only** review — no application code was changed to produce this report.

> **Legal disclaimer:** The Privacy & Legal Compliance section of this report is an engineering-informed summary for planning purposes only. It is **not legal advice** and must not be relied on as a substitute for review by a licensed attorney qualified in US privacy, consumer-protection, and housing law before launch or as the product scales. Laws and thresholds cited were current as of the search date (2026-07) and are described at a summary level; several (e.g., state privacy laws) are amended frequently.

---

## Executive Summary

The codebase shows a genuinely disciplined security baseline for a small team: no SQL injection surface (Prisma-only, zero raw queries), no XSS surface (no `dangerouslySetInnerHTML`/`innerHTML`, chat markdown is hand-rolled and escapes via React), no CSRF exposure (bearer-token auth only, no cookies), no secrets committed to git or bundled into the frontend, a clean `npm audit` (0 vulnerabilities across all workspaces), solid JWT verification (audience-checked, JWKS or HS256 secret), and — most importantly — **consistently correct object-level authorization**: every reviewed REST route and service function scopes reads/writes by the authenticated `accountId`, including multi-hop parent chains (Unit→Property, Lease→Unit→Property, Document→any-entity). No IDOR/BOLA bug was found in the code paths reviewed.

The most significant gaps are architectural and operational rather than classic injection/XSS bugs:

| # | Finding | Severity | Section |
|---|---|---|---|
| 1 | Postgres Row-Level Security is enabled but has **zero enforcement effect** — no policies exist, and Prisma connects as the privileged `postgres` role that bypasses RLS by design. Tenant isolation depends **100% on service-layer `accountId` scoping with no database-level backstop.** | **Medium (architectural)** | Security §A2, §A3 |
| 2 | `INTEGRATION_ENCRYPTION_KEY` (protects the Plaid bank-access token) has no KMS/rotation, and silently falls back to **storing the token in plaintext** if the key is unset in a real (non-mock) Plaid deployment — no runtime guard prevents this misconfiguration. | **High** | Security §A6 |
| 3 | `integration.service.ts` (Plaid connect / bank-token exchange / disconnect) performs **zero `AuditLog` writes** — the one write path handling live bank credentials is invisible to the audit trail. | **High** | Security §A9 |
| 4 | No security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options) anywhere in the Fastify app or the Cloudflare Worker edge layer. | **Medium** | Security §A5 |
| 5 | Full tenant PII (name/email/phone) and financial detail (exact amounts, vendors, descriptions) — and raw receipt **images** — are sent to the Anthropic API with no redaction/anonymization layer. | **Medium** | Security §A7 / Compliance §B6 |
| 6 | The app has **no privacy policy, no Terms of Service, and no consent capture anywhere** in the product (verified: zero references in `apps/web/src`). | **High (compliance)** | Compliance §B1, §B5 |
| 7 | Demo-mode auth silently grants full write access to the seeded account if `DEV_BEARER_TOKEN` is unset — safe under the documented production config (Supabase mode is always enabled in prod) but has no startup assertion to prevent a future misconfiguration from shipping wide open. | **Medium (config-dependent)** | Security §A1 |
| 8 | Uploaded file / receipt mimetype is validated by the **client-declared** `Content-Type` only — no magic-byte content sniffing. | **Medium** | Security §A11 |
| 9 | No hard-delete or data-erasure path exists anywhere (only soft-archive) — relevant both as a security data-minimization gap and as a CCPA/CPRA "right to delete" compliance gap. | **Medium** | Security §A12 / Compliance §B2 |
| 10 | No automated dependency-vulnerability scanning (no Dependabot config; `npm audit` is currently clean but nothing runs it continuously). | **Low** | Security §A13 |

**Overall risk posture for a US launch:** **Moderate-Low, with two High findings to close before scaling bank-linking usage, and one High-severity compliance gap (no privacy policy/ToS) that should block public launch regardless of user volume.** The application-layer security fundamentals (authz, input validation, injection/XSS surface, secrets hygiene) are stronger than what's typical for a pre-revenue SaaS at this stage. The two High findings (§2, §3) are both scoped to the Plaid/bank-integration feature specifically — if that feature is not yet in real (non-mock) use for any customer, they are pre-existing-risk rather than active-incident. The privacy-policy gap is a straightforward, low-effort fix (publish a policy + ToS, link them at signup) and should be treated as a launch blocker given every applicable US state law requires notice at or before collection.

### Prioritized remediation list

1. **(High)** Guard `INTEGRATION_ENCRYPTION_KEY`: fail startup (or fail `exchangePublicToken`) if the real Plaid adapter is selected but the key is unset, instead of silently persisting a plaintext bank token. Move the key to a managed secret store with a documented rotation runbook.
2. **(High)** Add `AuditLog` writes to every `integration.service.ts` mutation (`connectMock`, `exchangePublicToken`, `disconnect`).
3. **(High, compliance)** Publish a Privacy Policy and Terms of Service; link both from the signup screen (`apps/web/src/pages/Login.tsx`) with a required acknowledgment checkbox before account creation.
4. **(Medium)** Add `@fastify/helmet` (or equivalent manual headers) for CSP, HSTS, X-Content-Type-Options, X-Frame-Options at the API layer, and confirm/add equivalent headers at the Cloudflare Worker edge.
5. **(Medium)** Decide and document a redaction/minimization policy for what tenant/financial data is allowed to reach the Anthropic API (especially receipt images), and confirm Anthropic's commercial terms (zero-data-retention / no-training) are the ones actually in effect for this workload — see Compliance §B6.
6. **(Medium)** Add magic-byte content verification (e.g. `file-type` package) for document and receipt uploads, not just the client-declared MIME type.
7. **(Medium)** Design and ship a real data-deletion path (at minimum: an account-closure flow that hard-deletes or irreversibly anonymizes tenant PII on request) to satisfy CCPA/CPRA and similar state deletion rights.
8. **(Medium)** Add a startup assertion: refuse to boot in a non-test environment if neither Supabase mode nor `DEV_BEARER_TOKEN` is configured, closing the silent-open-auth footgun.
9. **(Low)** Switch the `CRON_SECRET` comparison in `internal.ts` to `crypto.timingSafeEqual`.
10. **(Low)** Enable Dependabot (or equivalent) for continuous dependency scanning; `npm audit` is currently clean but nothing runs it on a schedule.
11. **(Low)** Add audit logging to `category.service.ts` create; validate route `:id` path params with a shared Zod schema for consistency with the rest of the validation convention.
12. **(Process)** Complete the deployment plan's own unchecked launch-checklist items: verify cross-account isolation with a second real account in production, test a Supabase backup restore once, and document an incident-response/breach-notification runbook (see Compliance §B4).

---

## Part A — Security & Data Protection Audit

### A1. Authentication & session handling

**Supabase JWT verification is implemented correctly.** `apps/api/src/plugins/auth.ts:47-60` uses `jose`'s `jwtVerify`, either against a static HS256 secret (`SUPABASE_JWT_SECRET`) or a remote JWKS endpoint (`SUPABASE_URL/auth/v1/.well-known/jwks.json`), and checks the `aud: 'authenticated'` claim (`auth.ts:48,51,58`). `jwtVerify` inherently validates signature and expiry. On any failure the handler returns a generic 401 (`auth.ts:82-84`) with no fallback path. `payload.sub` is required (`auth.ts:85`).

- *Minor gap (Info):* no explicit `issuer` check is configured. Low risk in HS256 mode (the secret is already project-scoped) and low risk in JWKS mode (the JWKS URL is already project-specific), but adding an explicit `issuer` check costs little and removes any ambiguity.

**No client-controlled mode-downgrade.** `supabaseModeEnabled()` (`auth.ts:39-41`) reads only server-side env vars, re-evaluated per request; nothing in a request can select demo mode when Supabase mode is configured (confirmed by direct read and by the auth-focused subagent's review).

**Demo-mode open-auth footgun (Medium, config-dependent).** `apps/api/src/plugins/auth.ts:91-95`:
```ts
const token = process.env.DEV_BEARER_TOKEN;
if (token && req.headers.authorization !== `Bearer ${token}`) { ... 401 }
req.accountId = await getDemoAccountId();
```
If Supabase mode is off **and** `DEV_BEARER_TOKEN` is unset, every unauthenticated request silently receives full read/write access to the seeded demo account — by design, for offline demo/dev use. Per the deployment plan, production always runs Supabase mode, so this is not currently exploitable against `app.554properties.com`. It is nonetheless a footgun: nothing stops a future environment (a staging deploy, a customer's on-prem instance, a misconfigured preview) from booting with both unset and being wide open with no warning. **Remediation:** add a startup assertion that refuses to boot outside `NODE_ENV=test` unless one of the two modes is actually configured.

**Frontend session storage** (`apps/web/src/lib/supabase.ts:8-13`): `createClient()` is called with no custom `storage` option, so supabase-js defaults to `localStorage` for the access/refresh token pair — the standard SPA pattern. Token refresh is handled entirely by supabase-js (`getAccessToken()` calls `supabase.auth.getSession()`, `lib/supabase.ts:21-27`); tokens are attached only via an `Authorization` header (`apps/web/src/api/client.ts:28`, `sse.ts:90`) and never logged, put in a URL, or otherwise exposed. Logout (`apps/web/src/state/auth.tsx:79-82`, `supabase.auth.signOut()`) is a real server-side revocation, not just a client-side flag clear.

- *Residual risk (Info):* as with any SPA using `localStorage` for tokens, a persistent XSS bug anywhere in the app would let an attacker read the session token. No such XSS bug was found (see §A4), so this is a defense-in-depth note rather than an active vulnerability. A password-reset flow using neutral wording ("If an account exists for that email, a reset link is on its way," `Login.tsx:118-121`) correctly avoids user enumeration.

**Internal/cron endpoint.** `apps/api/src/routes/internal.ts:13-16` checks `X-Cron-Secret` with a plain `!==` comparison rather than `crypto.timingSafeEqual` — a low-risk, easy hardening fix given it's an internal-only endpoint (network jitter dwarfs any timing signal in practice) but worth doing. The endpoint and `/healthz` are correctly excluded from the main auth hook (`plugins/auth.ts:69,72`) and no other bypass exists.

### A2 & A3. Authorization: object-level authorization (IDOR/BOLA) and Row-Level Security reality check

**Object-level authorization is consistently correct.** A dedicated deep-dive across all 14 route files and their backing services (`properties.ts`, `units.ts`, `leases.ts`, `tenants.ts`, `transactions.ts`, `rent.ts`, `categories.ts`, `reports.ts`, `insights.ts`, `settings.ts`, `documents.ts`, `chat.ts`) found the same safe pattern everywhere: verify ownership via a scoped `findFirst`, then mutate by bare `id`. Examples:
- `unit.service.ts:47-48` — `findFirst({ where: { id, property: { accountId } } })` (parent-chain check for a child entity).
- `lease.service.ts:79-95, 218-221` — every lease operation (including `addTenant`/`removeTenant`/`createRenewal`/`draftRenewal`/`sendForEsign`) scopes through `unit.property.accountId`, and `addTenant` separately verifies the tenant being attached belongs to the same account.
- `document.service.ts:61-83` (`assertEntityOwned`) verifies the parent entity for every polymorphic document type before attach; `getForDownload`/`update`/`remove` (`document.service.ts:319,332,356`) all re-check `{ id, accountId }` — no IDOR in document download or delete.
- `chat.service.ts:39-43` (`getOwned`) gates session access, message send, and the `/answer` resume endpoint.
- `transaction.service.ts:211-215,441-443` — `confirmWithRentLink` additionally scopes the linked rent-payment lookup through `lease.unit.property.accountId`, preventing cross-account rent-payment linking.
- `insight.service.ts:70-72`, `integration.service.ts:129,156-158` — ownership `findFirst` before update/disconnect.

No handler was found that skips this check. This is the strongest part of the codebase's security posture.

**Row-Level Security is enabled but non-functional as a real control.** `apps/api/prisma/migrations/20260704222841_enable_rls/migration.sql` runs `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on all 15 core tables, and `20260709031654_add_documents/migration.sql:32` does the same for `Document`. **No `CREATE POLICY` statement exists anywhere in the migrations tree.** The migration's own comment is explicit about why: *"the API's Prisma connection uses the privileged `postgres` role, which bypasses RLS entirely, so this does not change app behavior... closes Supabase's 'RLS disabled on public table' advisory"* (`20260704222841_enable_rls/migration.sql:1-6`) — matching `docs/property-app-deployment-plan.md:215` verbatim.

**Implication:** RLS today is cosmetic compliance with Supabase's dashboard linter, not a second line of defense. All tenant isolation rests entirely on the service-layer `accountId` scoping described above. That scoping is, as far as this review found, correctly implemented everywhere — but there is **no database-level backstop** if a future service function is added (or an existing one is edited) without the ownership check. **Remediation options, in order of effort:** (a) keep as-is but treat this explicitly as a single point of failure requiring extra code-review rigor on every new service function that takes an `:id`; (b) write actual RLS policies keyed to a `current_setting('app.account_id')` session variable and have Prisma set it per-request via `$executeRaw` (adds real defense-in-depth at the cost of a second `accountId` mechanism to keep in sync); (c) at minimum, add an integration test that asserts cross-account access fails for every entity type, so a regression is caught in CI rather than in production. Per the deployment plan's own checklist, "cross-account isolation verified with a second, non-owner account in production" is still unchecked — this review's static analysis supports that the code is correct, but only a live two-account test closes that checklist item for real.

### A4. Input validation, injection, XSS, CSRF

- **Input validation:** `apps/api/src/plugins/zod-validation.ts` provides `parseBody`/`parseQuery` helpers, not a global hook — validation is opt-in per route rather than enforced by a plugin boundary. In practice all 13 route files with request bodies/queries call it consistently (spot-checked in `properties.ts:17,27,41` and `transactions.ts:30-61,82,92`) against `@hearth/shared` schemas. **Gap (Low):** route `:id` path params are never Zod-validated (e.g. `properties.ts:22,26,31,36,40`) — typed only as `{ id: string }`; malformed IDs fall through to Prisma, which 404s cleanly, so this is inconsistency rather than a live vulnerability.
- **SQL injection:** confirmed absent. `grep -rn '\$queryRaw\|\$executeRaw\|\$queryRawUnsafe\|\$executeRawUnsafe'` across `apps/api/src` returns zero hits — every query goes through Prisma's typed query builder.
- **XSS:** confirmed absent by design. No `dangerouslySetInnerHTML`/`.innerHTML =` anywhere in `apps/web/src`. The chat "markdown-lite" renderer (`apps/web/src/components/chat/blocks/TextBlock.tsx:1-74`) is a hand-rolled parser that only builds React elements from text — model-authored content can never inject markup, since React auto-escapes text children.
- **CSRF:** not applicable, confirmed. Auth is Bearer-token-only (`apps/web/src/api/client.ts:28`, `apps/api/src/plugins/auth.ts:74-89`) with no cookie-based session anywhere in the API or the Supabase client config — there is no ambient credential a forged cross-site request could exploit.

### A5. CORS, transport security, security headers

- **CORS:** `apps/api/src/app.ts:27-31` reads `CORS_ORIGIN` from env (comma-separated), falling back to localhost only when unset. This directly contradicts the deployment plan's own §4.6 note that CORS is "hardcoded to localhost" — **that doc line is stale**; the code has already been made env-driven. In the actual Cloudflare deployment, the Worker serves both the web bundle and `/api/*` same-origin (`deploy/worker.ts`), so CORS is largely moot for the primary production path.
- **Security headers — gap (Medium).** No `@fastify/helmet` dependency exists (`apps/api/package.json` — confirmed absent), no manual header-setting for CSP/HSTS/X-Frame-Options/X-Content-Type-Options anywhere in `apps/api/src` or `deploy/worker.ts`. Cloudflare's edge provides TLS termination but does not automatically add these headers. Concrete impact: without `X-Frame-Options`/a frame-ancestors CSP, the app could be embedded in a clickjacking iframe; without CSP, any future XSS vector would have zero defense-in-depth (today there is no known XSS vector, so this is preventive hardening, not a live exploit path).
- **Transport security:** production is fronted by Cloudflare, which terminates TLS and can be configured to enforce HTTPS; this review did not verify the live HSTS/redirect configuration at the Cloudflare dashboard level (out of scope for static code review) — recommend confirming "Always Use HTTPS" and an HSTS header are actually turned on in the Cloudflare zone settings.

### A6. Data at rest, encryption, bank-import path

**PII/financial data inventory** (`apps/api/prisma/schema.prisma`, full read): `Tenant.fullName/email/phone/notes` (106-113), `Account.name/email` (30-33), `Property` address fields (71-75), `Transaction.amountCents/vendor/description` (174-178), `Lease.rentCents` (127), `RentPayment.amountCents/externalRef` (203-207), `Report.dataJson` (231, a frozen financial snapshot). **None of these columns use column-level encryption** — everything is plaintext in Postgres, protected only by TLS-in-transit and Supabase's own at-rest disk encryption. This is normal for a SaaS relying on DB-level access control + `accountId` scoping, but it means there is no defense-in-depth if the database itself is compromised (backup theft, a misconfigured read replica, insider access at the hosting layer).

**Plaid bank-access-token encryption is well-implemented cryptographically, with a key-management gap.** `apps/api/src/lib/crypto.ts:16-23` uses AES-256-GCM with a random 12-byte IV per call, captures and verifies the GCM auth tag (`cipher.getAuthTag()` / `decipher.setAuthTag()`, lines 21/32), and stores `iv.authTag.ciphertext` (base64) in `Integration.configJson`. This is textbook-correct authenticated encryption.

- **(High) Silent plaintext fallback.** `apps/api/src/services/integration.service.ts:16-24`:
  ```ts
  function encodeAccessToken(accessToken: string): string {
    const key = process.env.INTEGRATION_ENCRYPTION_KEY;
    return key ? encrypt(accessToken, key) : accessToken;
  }
  ```
  If `INTEGRATION_ENCRYPTION_KEY` is unset, the real Plaid access token is stored **as plaintext** in `configJson` — intentional for mock/dev mode, but nothing in `exchangePublicToken` (`integration.service.ts:90-118`) checks whether the *real* (non-mock) Plaid adapter is in use before allowing this fallback. A production deploy with real `PLAID_CLIENT_ID`/`PLAID_SECRET` but a forgotten `INTEGRATION_ENCRYPTION_KEY` would silently persist live bank-access tokens in cleartext with no error, no log warning, and no test that would catch it in that specific combination.
- **(High) No key rotation / KMS.** The key is read directly from `process.env` (`integration.service.ts:17,22`) with no rotation mechanism — rotating it would break decryption for every existing stored token, and `disconnect()`'s cleanup path (`integration.service.ts:160-173`) explicitly swallows that exact failure mode ("a token stored in a different mode... may block the user's local disconnect. Swallow everything"). If this key is ever leaked, every account's bank-access token decrypts instantly.
- *Correctly done:* `real-plaid.ts` scrubs response headers before logging specifically to avoid leaking the Plaid secret in error logs — a deliberate, good defensive pattern.

**Remediation:** (1) make `exchangePublicToken` hard-fail if the real adapter is selected and the key is unset, rather than silently falling back to plaintext; (2) move the key into a managed secret store (Cloudflare secret + a documented rotation runbook, or a KMS-backed envelope-encryption scheme) so rotation doesn't require an all-at-once re-encryption of every row.

### A7. What data reaches the LLM (Anthropic)

`apps/api/src/ai/agent-loop.ts` sends every tool result to Anthropic verbatim as a `tool_result` content block (`JSON.stringify(result ?? null)`), with **no redaction, masking, or field-stripping layer** anywhere in `tools.ts`, `agent-loop.ts`, `prompts.ts`, or `anthropic.ts`. Concretely:

- `get_tenant` (`apps/api/src/ai/tools.ts:137-143`) returns full tenant contact info (name/email/phone) to the model whenever the agent calls it — which it will, for questions like "who's late on rent."
- `list_transactions`/`get_property_pnl` return exact `amountCents` and `vendor` strings.
- The system prompt itself instructs the model to carry tenant PII into `propose_action` API-call payloads shown back to the user (`apps/api/src/ai/prompts.ts:22-26`), by design (the assistant edits real records on the user's behalf).
- **Receipt-scan vision call** (`apps/api/src/ai/receipt.ts:118-139,232`): the actual receipt **image bytes** (base64-encoded) are sent to the real Anthropic API whenever `ANTHROPIC_API_KEY` is set. A receipt photo can incidentally contain a partial card number, a delivery address, or other PII beyond the vendor/amount the feature needs — none of that is cropped or redacted first. The system prompt does correctly treat the image as untrusted *data* rather than instructions (`receipt.ts:96`), which mitigates prompt-injection-via-receipt but not the data-exposure question.

This is very likely an intentional product-design tradeoff (the assistant's value is reasoning over real portfolio data), but it should be a **documented, conscious risk acceptance** rather than an implicit one — see Compliance §B6 for the DPA/data-processing-terms angle this raises.

### A8. Logging

The `aiUsage` structured log (`apps/api/src/ai/agent-loop.ts:158-173`, `receipt.ts:197-208`) is metadata-only — model name, token counts, account/session/message IDs — confirmed to carry **no prompt or response content**. No `console.log`/`request.log` call anywhere in `apps/api/src` (excluding tests) logs a full request body, JWT, or API key.

- **(Low) One leak in the mock email adapter:** `apps/api/src/integrations/mock/mock-email.ts:11` logs `[mock-email] ${messageId} → ${to}: ${subject}` to stdout, including the tenant's real email address. This is the dev/demo-only mock path (real email is not yet wired up per `FEATURES.md`), but if demo-mode logs ever ship to a shared aggregator without scrubbing, tenant emails would leak into log storage. Low severity, easy fix (log only the message ID).

### A9. Audit trail completeness

The `AuditLog` model is used broadly and correctly across `property.service.ts`, `unit.service.ts`, `tenant.service.ts`, `lease.service.ts`, `transaction.service.ts`, `rent.service.ts`, `report.service.ts`, `insight.service.ts`, and `document.service.ts` (including delete — `document.service.ts:351-377` does call `writeAudit` with `document.deleted` before returning, contrary to what one might assume).

**Two gaps found:**
- **(High) `apps/api/src/services/integration.service.ts` has zero `AuditLog` calls anywhere in the file** — verified by full read (reproduced in §A6 above). `exchangePublicToken` (connecting a live bank account, lines 90-118), `connectMock` (lines 56-82), and `disconnect` (lines 156-179, which wipes the stored token and revokes access) are all silent. This is exactly the class of "money/tenant-touching write" the `AuditLog` model exists for per the project's own binding convention — an attacker, a rogue insider, or a support agent connecting/disconnecting bank integrations on an account leaves zero trace.
- **(Low) `apps/api/src/services/category.service.ts:26-35`** (`create`) performs a write with no audit call. Lower stakes than integrations, but inconsistent with the stated convention.

### A10. Rate limiting, brute-force, enumeration

`@fastify/rate-limit` is registered with `global: false` (`apps/api/src/app.ts:41-45`) — opt-in per route. Confirmed coverage: the chat session-create/message/answer routes (`chat.ts`), the receipt-scan endpoint (`transactions.ts:16-26`), and the document-upload endpoint (`documents.ts:26-33`) all carry `config.rateLimit`. **Every other route (properties, tenants, leases, rent, reports, insights, dashboard, settings, categories) has no local rate limit**, relying entirely on the Cloudflare edge layer. If that edge protection is ever misconfigured or bypassed, these routes have no in-app throttle. Login/signup is fully delegated to Supabase Auth (rate-limited on Supabase's side); the one local identity-resolution path (`resolveAccountForIdentity`) only ever receives an already-Supabase-verified email, so it is not an unauthenticated enumeration oracle.

### A11. File uploads

- **Path traversal: well-mitigated (confirmed correct).** `document.service.ts:42-54` (`sanitizeFilename`) strips path separators and control characters, collapsing empty/`.`/`..` to a literal `'document'`; the storage key is `${accountId}/${documentId}/${sanitizedName}` where the attacker controls neither `accountId` nor `documentId`. The mock storage adapter adds a second layer rejecting any key containing a `..` segment, and the real (Supabase) storage adapter percent-encodes each path segment. Redundant, correctly layered defense.
- **Size caps:** enforced consistently — a global 10MB multipart limit (`app.ts:32`) plus a route-level re-check (`documents.ts:66-68`), and a separate, correctly-scoped 5MB cap for receipt images (`transactions.ts:16`).
- **(Medium) Mimetype allowlist is client-declared only.** `documents.ts:15-22,50` checks `file.mimetype` from the multipart header with no magic-byte content sniffing. An attacker could upload an HTML/SVG/polyglot file with a spoofed `Content-Type: application/pdf`. Combined with the download route serving files back using the *stored* (attacker-supplied-at-upload-time) mimetype, this is a stored-content-spoofing risk that becomes a stored-XSS-adjacent risk if such a file is ever served inline without a strict `Content-Type`/CSP. **Remediation:** verify actual file content (e.g. via the `file-type` npm package) against the declared MIME type before accepting an upload.
- **Uploads directory hygiene:** confirmed clean — `apps/api/uploads/` is gitignored, `git ls-files` returns nothing under it, and `git log --all -- apps/api/uploads` shows no history; no tenant documents were ever accidentally committed.

### A12. Backup/recovery and data deletion

No code implements hard deletion or a data-subject-erasure endpoint anywhere (`grep` for delete/erase/purge/GDPR/CCPA across `apps/api/src` found nothing). `Property.remove()`/`Tenant.remove()` only set `archivedAt` — this is a documented, intentional design choice for accounting-record integrity (Schedule E/P&L reports must retain historical data even for archived properties), but it means there is currently no way to fully remove a tenant's or account's PII on request, which is directly relevant to CCPA/CPRA-style deletion rights (see Compliance §B2). Archiving a Property or Tenant also does not cascade to delete attached `Document` blobs in storage — only the explicit `Document.remove()` path actually deletes bytes, so an archived tenant's uploaded lease/ID documents persist indefinitely, orphaned but still servable.

On backups: the deployment plan's own launch checklist lists "test a Supabase restore once, before an incident forces it" as still **unchecked** — this review did not independently verify Supabase's backup schedule/retention, but recommends closing that checklist item before real customer data accumulates further.

### A13. Dependency vulnerabilities

`npm audit --json` was run against the root workspace and both `apps/api`/`apps/web` (725 total dependencies across prod/dev/optional/peer): **0 vulnerabilities at any severity** in all three. No `.github/dependabot.yml` or equivalent exists, so this clean result is a point-in-time snapshot rather than a continuously-monitored guarantee. **Recommendation:** enable GitHub Dependabot alerts (free, minimal setup) so new CVEs in the dependency tree surface automatically — this was already an unchecked item on the deployment plan's own security checklist (§11).

### A14. Error handling / information disclosure

`apps/api/src/plugins/error-handler.ts:18-45` is well-built: Zod validation errors return field-level messages only (safe, expected 400s); `HttpError` returns developer-controlled codes/messages; Prisma's `P2025` (record not found) maps to a generic 404 with no ORM internals leaked; the unhandled-exception fallback logs the full error server-side (`req.log.error(err)`) but returns only `{ code: 'internal_error', message: 'Something went wrong' }` to the client — no stack traces or exception messages ever reach an API response, in any environment (this isn't gated by `NODE_ENV`, which is actually the safer default — no verbose-dev-mode leak risk).

---

## Part B — Privacy & Legal Compliance Audit (USA)

*(See disclaimer at the top of this report — this section is informational engineering-adjacent analysis, not legal advice.)*

### B1. Which US privacy laws likely apply

As of 2026, roughly twenty US states have comprehensive consumer privacy laws in force (CA, CO, CT, DE, FL, IN, IA, KY, MD, MN, MT, NE, NH, NJ, OR, RI, TN, TX, UT, VA among them). Applicability is generally threshold-gated:

- **California (CCPA/CPRA):** applies at >$26.6M annual gross revenue, or processing 100,000+ CA residents'/households' data annually, or deriving 50%+ of revenue from selling/sharing personal information.
- **Most Virginia-model states:** a similar pattern — ~$25M revenue and either 100,000 consumers processed, or 25,000 consumers combined with 50%+ revenue from data sales.
- **Texas (TDPSA):** notably **no revenue threshold** — applies to any business conducting business in Texas or targeting Texas residents (narrower small-business exemptions than most other states).
- **Connecticut:** lowered its consumer threshold to 75,000; **Oregon:** 100,000 consumers regardless of revenue mix; **Rhode Island:** 35,000 consumers (10,000 if 20%+ of revenue is from data sales).
- At least eleven states (CA, CO, CT, DE, MD, MN, MT, NJ, NH, OR, TX) require honoring **Global Privacy Control** browser opt-out signals.

**Assessment for 554 Properties today:** the product launched 2026-07-04 with zero pre-existing accounts and is a small-team SaaS — it is very unlikely to currently cross the CCPA/CPRA revenue or volume thresholds, and no third-party ad-tech/analytics scripts were found in the frontend (`apps/web/index.html`/`src` — no gtag/Segment/Mixpanel/etc.), which meaningfully simplifies "sale/sharing" opt-out obligations (there appears to be no sale/sharing of personal information to third parties today). **However:** Texas's law has no revenue floor, and the whole point of a nationwide launch is to acquire customers in exactly these states — the moment a Texas landlord signs up, the TDPSA's consumer-rights obligations (access, deletion, correction, opt-out) are the practical baseline the app should already support, since retrofitting rights infrastructure later is far more expensive than building it in from day one. **Recommendation:** treat a baseline set of consumer rights (access, deletion, correction) as a build-early requirement rather than a threshold-triggered one, given the multi-state nature of the target market.

*Sources:* [MultiState — 20 State Privacy Laws in Effect in 2026](https://www.multistate.us/insider/2026/2/4/all-of-the-comprehensive-privacy-laws-that-take-effect-in-2026), [Troutman Pepper Locke — US State Privacy Laws](https://www.troutman.com/insights/us-state-privacy-laws-california-colorado-connecticut-delaware-indiana-iowa-montana-oregon-tennessee-texas-utah-virginia/), [Secure Privacy — US State Privacy Law Tracker 2026](https://secureprivacy.ai/blog/us-state-privacy-law-tracker-2026)

### B2. Consumer rights the app must be able to support

CCPA/CPRA and the Virginia-model state laws all require the ability to honor requests to **know/access**, **delete**, **correct**, and (where applicable) **opt out of sale/sharing** of personal information; service-provider contracts must include specific mandatory terms (CCPA regs §7051) obligating sub-processors to also delete/return data on request.

**Gap identified (Medium, ties to Security §A12):** the app has no hard-delete or data-export path today — `Tenant`/`Property` removal is soft-archive only, and there is no user-facing "download my data" or "delete my account" flow found in `apps/web/src` or `apps/api/src/routes`. Given the account owner (the landlord) is the actual data controller/subject for most personal-account data, and **tenants themselves are not app users** (no tenant login exists per `FEATURES.md`: "No login in v1" for tenants), the more pressing angle is: (a) the landlord-user's own right to access/delete their account data, and (b) the landlord's own obligation, as the business collecting tenant data, to be *able* to fulfill a tenant's access/deletion request routed to them — which today would require a manual DB operation, not a self-service flow. **Recommendation:** build a self-service account-data export and a genuine deletion path (with the tax-record-retention carve-out already implicit in the soft-archive design honored explicitly, e.g., "delete PII fields but retain anonymized financial totals for tax records").

*Source:* [IAPP — Analyzing the CPRA's new contractual requirements for transfers of personal information](https://iapp.org/news/a/analyzing-the-cpras-new-contractual-requirements-for-transfers-of-personal-information), [TermsFeed — Complete Guide to CCPA Service Providers](https://www.termsfeed.com/blog/ccpa-service-providers/)

### B3. GLBA (Gramm-Leach-Bliley Act)

GLBA's Safeguards Rule and Privacy Rule apply to "financial institutions" — entities significantly engaged in financial activities (banks, mortgage lenders, finance companies, certain fintechs, real-estate settlement providers, etc.). **A property-management SaaS that lets landlords link their own bank accounts via Plaid for transaction import is not itself a financial institution** under the standard GLBA definition — it doesn't offer loans, investment advice, or payment processing to consumers as its core business. **Assessment: GLBA very likely does not directly apply to 554 Properties.** That said, because the app already handles bank-linked financial data via Plaid, voluntarily adopting Safeguards-Rule-style technical controls (encryption at rest for financial credentials, access controls, incident response planning) is good practice regardless of direct applicability — and the app already does some of this (AES-256-GCM for the Plaid token, per Security §A6), just with the key-management gap noted there. **Recommendation:** have counsel confirm this conclusion in writing given the Plaid integration, since GLBA's "significantly engaged" test is fact-specific.

*Source:* [FTC — Gramm-Leach-Bliley Act](https://www.ftc.gov/business-guidance/privacy-security/gramm-leach-bliley-act), [SaltyCloud/Isora — What Is GLBA?](https://www.saltycloud.com/blog/what-is-glba/)

### B4. Data breach notification obligations

All 50 states, DC, and US territories have breach-notification statutes; there is still no comprehensive federal law. About 20 states specify numeric deadlines (30-60 days), the rest use "without unreasonable delay" language; California's SB 446 (effective 2026-01-01) sets a strict 30-day consumer-notification deadline; 36 states also require regulator notice. Penalties vary widely (e.g., Texas: up to $100/individual/day of delay, capped at $250,000; Florida: up to $500,000/breach; New York SHIELD Act: up to $5,000/violation plus a private right of action for some claims).

**Gap identified (Medium, process):** no incident-response or breach-notification runbook was found in `docs/` — the closest artifact is the deployment plan's own unchecked backup-restore-test checklist item. Given the app stores tenant PII and (via Plaid) references to bank-linked financial data, a documented breach playbook (who is notified, what the 30/45/60-day clocks are per state the affected users are in, template notification language, regulator-notice thresholds) should exist **before** an incident, not be improvised during one.

*Source:* [Privacy Rights Clearinghouse — Data Breach Notification Laws: 50-State Survey (2026)](https://privacyrights.org/resources-tools/reports/data-breach-notification-laws-50-state-survey-2026-edition), [Foley & Lardner — State Data Breach Notification Laws](https://www.foley.com/insights/publications/2026/03/state-data-breach-notification-laws/)

### B5. Privacy Policy / Terms of Service / consent

**No privacy policy, no Terms of Service, and no consent capture exist anywhere in the product.** Verified by direct search: `grep -rniE "privacy policy|terms of service|consent" apps/web/src` returns zero matches, and `Login.tsx` (the entire signup surface) has no links to any policy document and no acknowledgment checkbox — a user can create an account with just email + password (or Google OAuth) and no notice of what data is collected or how it's used. **Severity: High for a public US launch.** Virtually every applicable state privacy law (and basic consumer-protection/UDAP principles enforced by the FTC and state AGs even absent a specific privacy statute) requires, at minimum, a privacy notice describing what's collected and why, made available at or before collection. This is also simply expected baseline hygiene for any SaaS handling PII and financial data. **Remediation:** publish a privacy policy and ToS (counsel-drafted, reflecting the actual data flows documented in this report — including the Anthropic/Plaid/Supabase processor relationships) and link both from the signup form, ideally behind a required checkbox.

### B6. Third-party processors: Supabase, Plaid, and the LLM provider (Anthropic)

- **Supabase** (Postgres hosting + Auth): a standard infrastructure/auth sub-processor. Recommend confirming a signed Data Processing Agreement (DPA) is in place — Supabase offers one commercially — since it processes essentially all PII and financial data at rest.
- **Plaid** (bank-import): Plaid's own standard agreements typically include DPA-equivalent terms and Plaid maintains its own compliance program (SOC 2, etc.); no additional finding here beyond confirming the agreement is executed for the account tier in use.
- **Anthropic (LLM):** this is the processor relationship most worth scrutinizing given Security §A7's finding that full tenant PII and financial detail (plus raw receipt images) flow into every relevant chat turn and the receipt-OCR feature. Current public information on Anthropic's data-handling tiers (verified via web search, 2026-07):
  - Anthropic's **Commercial Terms** (covering the API, Claude for Work/Team/Enterprise) state Anthropic **does not train on Customer Content** under those terms.
  - A **Zero Data Retention (ZDR)** arrangement is available for the Messages/Token-Counting APIs, subject to Anthropic's approval, under which inputs/outputs are not stored at rest except as needed for legal/safety compliance.
  - ZDR is **not available for every model** — some newer/specialty models require a minimum (e.g. 30-day) retention window regardless.
  
  **Recommendation:** confirm in writing (a) which Anthropic commercial terms actually govern this account (API vs. consumer terms — the consumer Claude.ai terms are a different, less appropriate regime for a business handling regulated data), (b) whether the specific model in use (`claude-sonnet-5` per `ARCHITECTURE.md`) is eligible for a Zero Data Retention arrangement, and (c) whether a signed DPA / Business Associate-equivalent agreement with Anthropic exists. If ZDR is not in place, the practical exposure is that tenant PII and financial data may be retained by a third party for some window — which should be disclosed in the privacy policy (§B5) and factored into the state-law data-minimization expectations described in §B1.

*Source:* [Anthropic — API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention), [Anthropic Privacy Center — Zero data retention agreement scope](https://privacy.claude.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to)

### B7. FCRA (Fair Credit Reporting Act) — tenant screening

**Assessment: not currently applicable.** A codebase-wide search found no tenant-screening, credit-check, or background-check feature anywhere in `apps/api`/`apps/web` — `FEATURES.md`/`WHATS_NEXT.md` describe no such capability, and the Tenant model (`schema.prisma:106-122`) holds only name/email/phone/notes with "no login in v1," no consumer-report integration. FCRA's adverse-action-notice requirements (name/address/phone of the reporting agency, a statement of rights, applicable even if the report was only a minor factor in the decision) only attach when a landlord uses a "consumer report" to make a tenant decision — **this app doesn't provide or broker consumer reports today.** **Forward-looking note:** if a tenant-screening/credit-check feature is ever added (a natural extension for a property-management SaaS), FCRA obligations (adverse action notices, permissible-purpose certification, CRA-partner compliance) would need to be built in from the start, not bolted on after.

*Source:* [FTC — Using Consumer Reports: What Landlords Need to Know](https://www.ftc.gov/business-guidance/resources/using-consumer-reports-what-landlords-need-know)

### B8. Fair Housing Act — AI decisioning and disparate impact

HUD issued guidance in May 2024 specifically addressing algorithmic/AI-driven tenant screening and advertising under the Fair Housing Act, focused on disparate impact against protected classes (race, familial status, disability) from automated scoring/screening tools, and recommending: use only relevant, published screening criteria; apply human discretion; give applicants a chance to contest denials; ensure accuracy/non-discrimination in any scoring model.

**Assessment: low risk today, by design.** The AI agent in this app (`apps/api/src/ai/prompts.ts:12-29`) is explicitly scoped to *assist the landlord* with cash flow, reporting, and portfolio questions — it does not screen, score, qualify, or make any accept/deny decision about a tenant or applicant. The system prompt explicitly restricts the model to *proposing* actions via `propose_action`, which the human landlord must click to execute (`agent-loop.ts`/`ARCHITECTURE.md §6` — "the assistant never executes the action itself"). The four rule-based `Insight` types (`late_rent`, `expense_spike`, `renewal_window`, `underperforming_property`) are deterministic, transparent business rules operating on the landlord's own existing tenants/leases — not an applicant-screening or approval/denial system, and not scored against any protected-class-correlated input. **No HUD-guidance-triggering feature exists in the current product.** **Forward-looking note:** if a future feature ever scores or ranks *applicants* (as opposed to assisting with already-signed tenants), the HUD guidance's transparency/contestability/accuracy recommendations should be built into that feature's design from the outset.

*Source:* [HUD — Fair Housing Act Guidance on Applications of Artificial Intelligence (2024)](https://archives.hud.gov/news/2024/pr24-098.cfm), [Consumer Financial Services Law Monitor — HUD Guidance on Tenant Screening/AI](https://www.consumerfinancialserviceslawmonitor.com/2024/05/hud-issues-guidance-on-applicability-of-the-fair-housing-act-to-tenant-screening-and-housing-related-advertising-that-relies-upon-algorithms-and-ai/)

### B9. Data retention & minimization — summary

`Report.dataJson` snapshots are intentionally retained indefinitely once generated (by design, for tax-record integrity — a filed year should never silently change, per `ARCHITECTURE.md §2`) — appropriate for its purpose. Everything else follows the soft-archive pattern (Security §A12): no field has an automatic expiry/purge, and no data-minimization pass (e.g., stripping tenant PII from years-old archived records while retaining anonymized financial totals) exists. This is consistent with a young, small-scale product, but should be revisited as retention-minimization expectations under state privacy laws (§B1) become a practical compliance requirement rather than a theoretical one.

---

## Appendix

### Dependency audit (npm audit, 2026-07-09)

| Workspace | Critical | High | Moderate | Low | Total deps |
|---|---|---|---|---|---|
| root | 0 | 0 | 0 | 0 | 725 |
| apps/api | 0 | 0 | 0 | 0 | 725 |
| apps/web | 0 | 0 | 0 | 0 | 725 |

No automated continuous scanning (Dependabot or equivalent) is currently configured — see Security §A13.

### What this review did not do

- No live penetration testing or authenticated exploitation against production.
- No verification of Cloudflare edge configuration (HSTS/redirect rules, WAF rules, rate-limit rules) beyond what's visible in `wrangler.jsonc`/`deploy/worker.ts`.
- No verification of Supabase's actual backup schedule/retention or a live restore test.
- No confirmation of executed DPAs/contracts with Supabase, Plaid, or Anthropic — only public terms were reviewed.
- No live two-account cross-tenant test in production (the deployment plan's own checklist item remains open; this report's authorization findings are based on static code analysis only).

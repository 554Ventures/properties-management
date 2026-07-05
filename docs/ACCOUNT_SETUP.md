# Account Wiring Guide — what you (the human) need to click

> **Status: ✅ completed 2026-07-04 — all accounts wired, production live at
> https://app.554properties.com.** Kept as the reference for how everything
> is connected, and as the template for a future staging environment (second
> Supabase project + Worker environment). Deployment credentials live in the
> gitignored `.secrets.local` at the repo root.
>
> Remaining post-launch follow-ups live in the deployment plan §13 (restore
> test, edge rate rule, uptime check, second-account isolation check, key
> rotation).

This is the account-side checklist to take Hearth live: Supabase, Anthropic,
Cloudflare, GitHub — in that order, since later steps consume values from
earlier ones.

Instructions verified against provider docs on **2026-07-04**. Dashboards
change; if a menu item moved, the concept names below should still find it
via each dashboard's search.

Keep a scratch note while you go — you'll collect ~8 values marked **📋 collect**.

---

## 1. Supabase (auth + database)

### 1.1 Create the project

1. [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**, name it `hearth-prod` (one project = one environment; staging later would be a second project).
2. Choose a region near your users. Generate a strong **database password** — 📋 collect it.

### 1.2 API keys — note the new names

Supabase renamed its keys in 2025. In **Settings → API Keys**:

- **Publishable key** (`sb_publishable_…`) — this is what older docs call the `anon` key. Safe to ship in the frontend. 📋 collect → becomes `VITE_SUPABASE_ANON_KEY` (our env var keeps the old name; the value is the publishable key).
- **Secret key** (`sb_secret_…`) — **do not collect**. Hearth's API talks to Postgres via Prisma, not the Supabase data API, so we deliberately never provision this (plan §7).
- Project URL (`https://<ref>.supabase.co`) — 📋 collect → becomes both `SUPABASE_URL` (API container) and `VITE_SUPABASE_URL` (web build).

### 1.3 JWT verification — nothing to copy

New projects sign access tokens with **asymmetric JWT signing keys** (see **Settings → JWT signing keys**). The API verifies them via the public JWKS endpoint `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json` — which our auth plugin derives from `SUPABASE_URL` automatically. **Do not** migrate to or copy the legacy JWT secret; leave `SUPABASE_JWT_SECRET` unset in production (it exists only for tests/legacy projects).

### 1.4 Auth settings

In **Authentication → Sign In / Up**: make sure **Email** provider is enabled (it is by default) and leave **Confirm email** ON — the login page already handles the "check your email" flow.

In **Authentication → URL Configuration**: set **Site URL** to `https://app.yourdomain.com` (confirmation emails link here). Add `http://localhost:5173` to **Redirect URLs** if you also want to log into prod Supabase from local dev.

Branded auth emails (confirm signup, reset password, etc.) live in `supabase/email-templates/` — apply them with `node supabase/email-templates/apply.mjs` (needs a Supabase access token + project ref) or paste per its README. Content-only; wire a custom SMTP provider before real signup volume.

### 1.5 Connection strings

Click **Connect** at the top of the dashboard. You need the **Session pooler** string (port **5432**, via Supavisor):

```
postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

📋 collect it **twice** — it serves as both:
- `DATABASE_URL` for the API container (a long-lived container is a "server-based deployment" in Supabase's Prisma guidance → session pooler for app traffic), and
- the `DATABASE_URL_DIRECT` GitHub Actions secret for CI migrations.

⚠️ **Do not use the "Direct connection" string in CI**: it's IPv6-only, and GitHub Actions runners have no IPv6. The session pooler is IPv4-compatible and fully supports migrations. (If the container fleet ever runs many instances and you see connection-count pressure, switch the app's `DATABASE_URL` to the **Transaction pooler** string on port 6543 with `?pgbouncer=true` appended — Prisma needs that flag there.)

### 1.6 Billing alert

**Organization settings → Billing** → set a spend cap / usage alert (launch checklist item).

---

## 2. Anthropic (chat)

1. [console.anthropic.com](https://console.anthropic.com) → **API Keys** → create `hearth-prod`. 📋 collect → `ANTHROPIC_API_KEY`.
2. **Settings → Limits/Billing**: set a monthly spend limit and email alert now — there's no staging key absorbing experiments, and the app logs `aiUsage` lines you can reconcile against the invoice.
3. Optional: pin the model via `ANTHROPIC_MODEL` (defaults to `claude-sonnet-5`).

---

## 3. Cloudflare (compute + frontend + DNS)

### 3.1 Plan + domain

1. **Workers Paid plan ($5/mo)** — required for Containers. Dashboard → Workers & Pages → Plans.
2. Add your domain to Cloudflare (if not already): **Add site**, follow the nameserver switch. Lower the TTL in advance if you're cutting over an existing domain.

### 3.2 API token for CI

**My Profile → API Tokens → Create Token** → start from the *Edit Cloudflare Workers* template and add **Cloudflare Pages: Edit** permission. Scope to your account + zone. 📋 collect → `CLOUDFLARE_API_TOKEN` GitHub secret.

### 3.3 The Worker (web + API in one) — *scaffolded 2026-07-04*

The repo now has `wrangler.jsonc` + `deploy/worker.ts`: a single Worker that serves the web bundle as **static assets** and routes `/api/*` to the Fastify container (this superseded the earlier separate-Pages design — same-origin by construction, one deploy). `npx wrangler deploy` builds the image, pushes it to Cloudflare's registry, and provisions the container; the Cron Trigger and the `app.554properties.com` custom domain are declared in the same config.

Worker secrets (set once with `npx wrangler secret put <NAME>`; forwarded into the container):

| Secret | Value from |
|---|---|
| `DATABASE_URL` | Supabase session pooler (§1.5) |
| `SUPABASE_URL` | §1.2 |
| `ANTHROPIC_API_KEY` | §2 |
| `CRON_SECRET` | generated (in `.secrets.local`) |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` | §6 — optional, falls back to the mock adapter until set |
| `PLAID_ENV` | §6 — literal `sandbox` for now |
| `INTEGRATION_ENCRYPTION_KEY` | §6 — self-generated, not from Plaid |

Instance sizing: `basic` to start; revisit after load testing (plan open item #2).

### 3.5 Edge extras (after DNS is live)

- **Rate limiting rule** on `app.yourdomain.com/api/v1/chat/*` (Security → WAF → Rate limiting rules) as the edge layer above the app's own per-account limiter.
- **Uptime check** (or any free external monitor) hitting `https://app.yourdomain.com/api/v1/healthz`.

---

## 4. GitHub (CI → deploy)

1. **Settings → Environments → New environment**: `production`. Add secrets:
   - `DATABASE_URL_DIRECT` = Supabase **session pooler** string (§1.5 — *not* the IPv6 direct string)
   - `CLOUDFLARE_API_TOKEN` (§3.2)
2. **Settings → Rules → Rulesets** (or classic branch protection) on `main`: require the **CI / checks** status check to pass. **Don't** require an approving review while you're solo — GitHub won't let you approve your own PR (plan §6).
3. **Settings → Security → Dependabot**: enable alerts (+ security updates).
4. Finally, uncomment the `deploy` job template at the bottom of `.github/workflows/ci.yml` (it already references these secret names) once §3.3's wrangler config exists.

---

## 5. Order of operations, condensed

1. Supabase project → keys, pooler string, auth URLs, billing alert
2. Anthropic key + spend limit
3. Cloudflare: paid plan, domain, API token → *ask Claude to scaffold the Worker/wrangler config* → deploy container + secrets → Pages project + custom domain → edge rate rule
4. GitHub: `production` environment secrets → ruleset → enable deploy job
5. Run the launch checklist in the deployment plan §13 (cross-account isolation with a second real account, restore-test a backup, demo seed never touches prod, cron verified)

---

## 6. Plaid (bank import) — *added 2026-07-04*

Real Sandbox bank-transaction import (`docs/WHATS_NEXT.md` §3). Optional — the app runs the mock Plaid adapter until these are set.

1. [dashboard.plaid.com](https://dashboard.plaid.com) → sign up (free for Sandbox, no approval wait) → **Team Settings → Keys**. 📋 collect the **Sandbox** `client_id` and `secret` → `PLAID_CLIENT_ID` / `PLAID_SECRET`.
2. Set `PLAID_ENV=sandbox`. Production requires Plaid's separate app-review process — out of scope until the app has real users linking real banks.
3. Generate a dedicated encryption key for at-rest storage of the Plaid access token (this is unrelated to Plaid's own keys): `openssl rand -base64 32` → `INTEGRATION_ENCRYPTION_KEY`. All three vars must be set together or the app falls back to the mock adapter (a boot-time warning fires if only some are set).
4. To test: Settings → Connect on the Plaid row → pick any Sandbox institution → log in with Plaid's test credentials (`user_good` / `pass_good`, any Sandbox-supported institution) → Money → "Import from bank" (a second click a little later may be needed — Plaid's first sync after linking commonly returns 0 rows while it finishes its initial pull).
5. Moving to Production later is a values-only swap: new `PLAID_CLIENT_ID`/`PLAID_SECRET` from Plaid's Production keys (after their review) + `PLAID_ENV=production`. `INTEGRATION_ENCRYPTION_KEY` stays the same.

## Values you should have collected

| # | Value | Goes to |
|---|---|---|
| 1 | Supabase DB password | inside the pooler strings |
| 2 | Supabase project URL | container `SUPABASE_URL` + Pages `VITE_SUPABASE_URL` |
| 3 | Publishable key (`sb_publishable_…`) | Pages `VITE_SUPABASE_ANON_KEY` |
| 4 | Session pooler string | container `DATABASE_URL` + GitHub `DATABASE_URL_DIRECT` |
| 5 | Anthropic API key | container `ANTHROPIC_API_KEY` |
| 6 | Cloudflare API token | GitHub `CLOUDFLARE_API_TOKEN` |
| 7 | `CRON_SECRET` (self-generated) | container + Worker |
| 8 | (nothing else — the Supabase secret key is deliberately never provisioned) |
| 9 | Plaid Sandbox `client_id`/`secret` (§6) | container `PLAID_CLIENT_ID` / `PLAID_SECRET` |
| 10 | `INTEGRATION_ENCRYPTION_KEY` (self-generated, §6) | container secret |

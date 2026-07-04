# Account Wiring Guide — what you (the human) need to click

Everything code-side is done (deployment plan §4). This is the account-side
checklist to take Hearth live: Supabase, Anthropic, Cloudflare, GitHub — in
that order, since later steps consume values from earlier ones.

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

### 3.3 Containers (the API)

The repo has the Dockerfile (`apps/api/Dockerfile`) but **not yet** the fronting Worker + `wrangler.jsonc` — that's a small code task that needs your account to exist first (ask Claude to scaffold it; it's the `containers-template` pattern: a Durable-Object-backed Worker that routes `app.yourdomain.com/api/*` to the container, plus a Cron Trigger).

When it exists, `npx wrangler deploy` will build the image, push it to Cloudflare's registry, and provision the container (first provisioning takes several minutes). Container runtime secrets to set (via `wrangler secret put` or dashboard):

| Secret | Value from |
|---|---|
| `DATABASE_URL` | Supabase session pooler (§1.5) |
| `SUPABASE_URL` | §1.2 |
| `ANTHROPIC_API_KEY` | §2 |
| `CRON_SECRET` | generate: `openssl rand -hex 32` 📋 collect (needed by both Worker and container) |

Instance sizing: start with the smallest that fits (`lite`/`basic`); revisit after load testing (plan open item #2).

### 3.4 Pages (the web app)

**Workers & Pages → Create → Pages → Connect to Git** → select the repo.
- Build command: `npm run build --workspace apps/web`
- Build output directory: `apps/web/dist`
- Build-time env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the publishable key, §1.2)

Then **Custom domains** → add `app.yourdomain.com`. PR preview deployments are on by default — remember previews hit the production API/database (accepted risk, plan §5).

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

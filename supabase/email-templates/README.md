# Supabase Auth email templates — 554 Properties

Branded HTML for every transactional email Supabase Auth can send. Design matches the app: near-black text on white, thin `#ebeae7` hairlines, generous whitespace, one dark-orange (`#bc4514`) button, and the 554 Properties mark. Light-only by design (email dark-mode support is inconsistent across clients).

The logo loads from the live site: `https://app.554properties.com/apple-touch-icon.png`. If clients block images, the text wordmark still brands the email.

## Files → Supabase template

| File | Supabase template (Auth → Emails) | Subject | Merge var |
|---|---|---|---|
| `confirm-signup.html` | Confirm signup | Confirm your 554 Properties email | `{{ .ConfirmationURL }}` |
| `invite.html` | Invite user | You're invited to 554 Properties | `{{ .ConfirmationURL }}` |
| `magic-link.html` | Magic Link | Your 554 Properties sign-in link | `{{ .ConfirmationURL }}` |
| `change-email.html` | Change Email Address | Confirm your new 554 Properties email | `{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .NewEmail }}` |
| `reset-password.html` | Reset Password | Reset your 554 Properties password | `{{ .ConfirmationURL }}` |
| `reauthentication.html` | Reauthentication | Your 554 Properties verification code | `{{ .Token }}` |

**Active in the current app:** the signup flow uses **Confirm signup**; password reset uses **Reset Password**. The other four are branded so nothing is ever off-brand if enabled later (collaborators/invites, magic-link login, email change, MFA reauth).

## Apply — option A: one command (recommended)

Pushes all six via the Management API. Needs a **personal access token** (Dashboard → Account → Access Tokens — *not* the anon/publishable key) and the **project ref** (`<ref>` in `https://<ref>.supabase.co`).

```bash
SUPABASE_ACCESS_TOKEN=sbp_xxx SUPABASE_PROJECT_REF=<ref> \
  node supabase/email-templates/apply.mjs
```

Idempotent and scoped — it only writes the six `mailer_*` fields, leaving all other auth settings untouched. Keep the token out of git (export it, or source it from the gitignored `.secrets.local`).

## Apply — option B: dashboard paste

Authentication → **Emails** → pick each template → set the **Subject** from the table above → paste the file's contents into the **Message body (HTML)** → Save. Repeat per template.

## After applying

- Site URL must be `https://app.554properties.com` (Authentication → URL Configuration) so `{{ .ConfirmationURL }}` links land back in the app — see `docs/ACCOUNT_SETUP.md` §1.4.
- Send a real test (sign up a throwaway address) and check rendering in at least one desktop + one mobile client.
- Editing a template? Edit the file here and re-run `apply.mjs` so the repo stays the source of truth.

> Note: these change **content only**. The sender name/address and deliverability come from your SMTP setup — Supabase's built-in SMTP is rate-limited and meant for testing; wire a custom SMTP provider (Authentication → Emails → SMTP Settings) before real signup volume.

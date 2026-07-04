#!/usr/bin/env node
// Push the branded auth email templates in this folder to a hosted Supabase
// project via the Management API. Dashboard-free, idempotent — safe to re-run.
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=sbp_xxx SUPABASE_PROJECT_REF=abcdefgh \
//     node supabase/email-templates/apply.mjs
//
//   # or pass the ref as an argument:
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node supabase/email-templates/apply.mjs abcdefgh
//
// - SUPABASE_ACCESS_TOKEN: a personal access token from
//   https://supabase.com/dashboard/account/tokens  (NOT the anon/publishable
//   key). Keep it out of the repo — export it in your shell or .secrets.local.
// - SUPABASE_PROJECT_REF: the project ref, i.e. the "<ref>" in
//   https://<ref>.supabase.co (Settings → General).
//
// Only touches the six mailer_* template/subject fields; every other auth
// setting is left exactly as-is.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF ?? process.argv[2];

if (!token || !ref) {
  console.error(
    'Missing credentials.\n' +
      '  SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=<ref> node supabase/email-templates/apply.mjs',
  );
  process.exit(1);
}

// Supabase Auth config keys → the template file that fills them.
const TEMPLATES = [
  { file: 'confirm-signup.html',    subject: 'Confirm your 554 Properties email',       key: 'confirmation' },
  { file: 'invite.html',            subject: "You're invited to 554 Properties",         key: 'invite' },
  { file: 'magic-link.html',        subject: 'Your 554 Properties sign-in link',         key: 'magic_link' },
  { file: 'change-email.html',      subject: 'Confirm your new 554 Properties email',    key: 'email_change' },
  { file: 'reset-password.html',    subject: 'Reset your 554 Properties password',       key: 'recovery' },
  { file: 'reauthentication.html',  subject: 'Your 554 Properties verification code',    key: 'reauthentication' },
];

const body = {};
for (const { file, subject, key } of TEMPLATES) {
  body[`mailer_subjects_${key}`] = subject;
  body[`mailer_templates_${key}_content`] = readFileSync(join(here, file), 'utf8');
}

const url = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
const res = await fetch(url, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.error(`✗ Supabase rejected the update (${res.status} ${res.statusText}):`);
  console.error(await res.text());
  process.exit(1);
}

console.log(`✓ Applied ${TEMPLATES.length} branded email templates to project ${ref}:`);
for (const { key } of TEMPLATES) console.log(`  · ${key}`);
console.log('\nSend yourself a test (e.g. sign up a throwaway address) to confirm rendering.');

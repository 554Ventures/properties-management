// The Worker fronting Hearth in production (deployment plan §3): serves the
// web bundle as static assets, routes /api/* to the Fastify container, and
// fires the daily-jobs cron against the container's guarded internal
// endpoint. Config lives in wrangler.jsonc at the repo root.
import { Container, getContainer } from '@cloudflare/containers';
import { env } from 'cloudflare:workers';

// `cloudflare:workers` types env against the wrangler-generated global Env,
// which this repo doesn't generate — assert to the local interface instead.
const secrets = env as unknown as Env;

// A secret that isn't set on the Worker must be DROPPED, not forwarded: the
// container runtime stringifies env values, so an undefined arrives in the
// container as the literal string "undefined" — which reads as *configured*
// downstream (e.g. SUPABASE_STORAGE_BUCKET became a bucket named "undefined",
// 500ing every document upload while the real default bucket sat unused).
function definedEnvVars(vars: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vars).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

export class HearthApi extends Container<Env> {
  defaultPort = 3001;
  // Scale to zero when idle; the cron trigger wakes it for daily jobs.
  sleepAfter = '15m';
  // Worker secrets forwarded into the container process (Fastify reads them
  // as normal env vars — same names as .env.example). Plaid's three secrets
  // (+ PLAID_ENV) must all be forwarded together, else the API silently falls
  // back to the mock Plaid adapter (integrations/factory.ts).
  envVars = definedEnvVars({
    DATABASE_URL: secrets.DATABASE_URL,
    SUPABASE_URL: secrets.SUPABASE_URL,
    ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY,
    CRON_SECRET: secrets.CRON_SECRET,
    PLAID_CLIENT_ID: secrets.PLAID_CLIENT_ID,
    PLAID_SECRET: secrets.PLAID_SECRET,
    PLAID_ENV: secrets.PLAID_ENV,
    INTEGRATION_ENCRYPTION_KEY: secrets.INTEGRATION_ENCRYPTION_KEY,
    // Stripe Financial Connections — both forwarded together, else the API
    // silently falls back to the mock Stripe FC adapter (same failure mode as
    // Plaid above: Settings "connects" instantly with no Stripe modal).
    STRIPE_SECRET_KEY: secrets.STRIPE_SECRET_KEY,
    STRIPE_PUBLISHABLE_KEY: secrets.STRIPE_PUBLISHABLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY: secrets.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_STORAGE_BUCKET: secrets.SUPABASE_STORAGE_BUCKET,
    // APNs push (docs/MOBILE.md) — all five forwarded together, else the API
    // falls back to the mock push provider (integrations/factory.ts).
    APNS_TEAM_ID: secrets.APNS_TEAM_ID,
    APNS_KEY_ID: secrets.APNS_KEY_ID,
    APNS_PRIVATE_KEY: secrets.APNS_PRIVATE_KEY,
    APNS_BUNDLE_ID: secrets.APNS_BUNDLE_ID,
    APNS_ENV: secrets.APNS_ENV,
    // Outbound email (Cloudflare Email Service) — the first three forwarded
    // together, else the API falls back to the mock email adapter
    // (integrations/factory.ts). FEEDBACK_NOTIFY_EMAIL is where "Send
    // feedback" submissions are mailed (unset = store-only, no notification).
    CLOUDFLARE_EMAIL_API_TOKEN: secrets.CLOUDFLARE_EMAIL_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: secrets.CLOUDFLARE_ACCOUNT_ID,
    EMAIL_FROM: secrets.EMAIL_FROM,
    FEEDBACK_NOTIFY_EMAIL: secrets.FEEDBACK_NOTIFY_EMAIL,
    FEEDBACK_RATE_LIMIT_MAX: secrets.FEEDBACK_RATE_LIMIT_MAX,
  });
}

interface Env {
  HEARTH_API: DurableObjectNamespace<HearthApi>;
  ASSETS: Fetcher;
  DATABASE_URL: string;
  SUPABASE_URL: string;
  ANTHROPIC_API_KEY: string;
  CRON_SECRET: string;
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  PLAID_ENV: string;
  INTEGRATION_ENCRYPTION_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_PUBLISHABLE_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_STORAGE_BUCKET: string;
  APNS_TEAM_ID: string;
  APNS_KEY_ID: string;
  APNS_PRIVATE_KEY: string;
  APNS_BUNDLE_ID: string;
  APNS_ENV: string;
  CLOUDFLARE_EMAIL_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  EMAIL_FROM: string;
  FEEDBACK_NOTIFY_EMAIL: string;
  FEEDBACK_RATE_LIMIT_MAX: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      // Single named instance — one warm container serves all API traffic
      // (instance sizing revisited after load testing; plan open item #2).
      return getContainer(env.HEARTH_API, 'api').fetch(request);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env): Promise<void> {
    const res = await getContainer(env.HEARTH_API, 'api').fetch(
      new Request('http://hearth-api/api/v1/internal/run-daily-jobs', {
        method: 'POST',
        headers: { 'x-cron-secret': env.CRON_SECRET },
      }),
    );
    if (!res.ok) {
      throw new Error(`daily jobs failed: ${res.status} ${await res.text()}`);
    }
  },
} satisfies ExportedHandler<Env>;

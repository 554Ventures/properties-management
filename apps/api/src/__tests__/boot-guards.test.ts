// Pure env-var guards (security remediation, docs/SECURITY_PRIVACY_AUDIT.md) —
// no DB/app involved, so these run against whatever process.env looks like in
// the test process without touching the shared test database.
import { afterEach, describe, expect, it } from 'vitest';
import { assertProductionConfig } from '../lib/boot-guards';

const GUARD_VARS = [
  'NODE_ENV',
  'SUPABASE_JWT_SECRET',
  'SUPABASE_URL',
  'DEV_BEARER_TOKEN',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'INTEGRATION_ENCRYPTION_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
] as const;

const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of GUARD_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
    delete saved[key];
  }
});

function set(key: (typeof GUARD_VARS)[number], value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('assertProductionConfig', () => {
  it('is a no-op outside production (dev/test config, both auth and Plaid unset)', () => {
    set('NODE_ENV', 'test');
    expect(() => assertProductionConfig()).not.toThrow();
  });

  it('throws in production when neither Supabase mode nor DEV_BEARER_TOKEN is configured', () => {
    set('NODE_ENV', 'production');
    set('SUPABASE_JWT_SECRET', undefined);
    set('SUPABASE_URL', undefined);
    set('DEV_BEARER_TOKEN', undefined);
    expect(() => assertProductionConfig()).toThrow(/no auth configured/);
  });

  it('passes in production with Supabase mode configured (SUPABASE_URL) and no Plaid vars', () => {
    set('NODE_ENV', 'production');
    set('SUPABASE_URL', 'https://project.supabase.co');
    set('SUPABASE_JWT_SECRET', undefined);
    set('DEV_BEARER_TOKEN', undefined);
    set('PLAID_CLIENT_ID', undefined);
    set('PLAID_SECRET', undefined);
    set('INTEGRATION_ENCRYPTION_KEY', undefined);
    expect(() => assertProductionConfig()).not.toThrow();
  });

  it('passes in production with DEV_BEARER_TOKEN configured (no Supabase)', () => {
    set('NODE_ENV', 'production');
    set('SUPABASE_JWT_SECRET', undefined);
    set('SUPABASE_URL', undefined);
    set('DEV_BEARER_TOKEN', 'shared-secret');
    expect(() => assertProductionConfig()).not.toThrow();
  });

  it('throws in production when Plaid env vars are partially set (encryption key missing)', () => {
    set('NODE_ENV', 'production');
    set('SUPABASE_URL', 'https://project.supabase.co');
    set('PLAID_CLIENT_ID', 'client-id');
    set('PLAID_SECRET', 'plaid-secret');
    set('INTEGRATION_ENCRYPTION_KEY', undefined);
    expect(() => assertProductionConfig()).toThrow(/Plaid partially configured/);
  });

  it('throws in production when only the encryption key is set (Plaid creds missing)', () => {
    set('NODE_ENV', 'production');
    set('SUPABASE_URL', 'https://project.supabase.co');
    set('PLAID_CLIENT_ID', undefined);
    set('PLAID_SECRET', undefined);
    set('INTEGRATION_ENCRYPTION_KEY', Buffer.alloc(32, 1).toString('base64'));
    expect(() => assertProductionConfig()).toThrow(/Plaid partially configured/);
  });

  it('passes in production with all three Plaid vars set together', () => {
    set('NODE_ENV', 'production');
    set('SUPABASE_URL', 'https://project.supabase.co');
    set('PLAID_CLIENT_ID', 'client-id');
    set('PLAID_SECRET', 'plaid-secret');
    set('INTEGRATION_ENCRYPTION_KEY', Buffer.alloc(32, 1).toString('base64'));
    expect(() => assertProductionConfig()).not.toThrow();
  });

  it('passes in production with all three Plaid vars left unset', () => {
    set('NODE_ENV', 'production');
    set('SUPABASE_URL', 'https://project.supabase.co');
    set('PLAID_CLIENT_ID', undefined);
    set('PLAID_SECRET', undefined);
    set('INTEGRATION_ENCRYPTION_KEY', undefined);
    expect(() => assertProductionConfig()).not.toThrow();
  });

  it('throws in production when only STRIPE_SECRET_KEY is set (publishable key missing)', () => {
    set('NODE_ENV', 'production');
    set('SUPABASE_URL', 'https://project.supabase.co');
    set('STRIPE_SECRET_KEY', 'sk_test_123');
    set('STRIPE_PUBLISHABLE_KEY', undefined);
    expect(() => assertProductionConfig()).toThrow(
      /Stripe Financial Connections partially configured/,
    );
  });

  it('throws in production when only STRIPE_PUBLISHABLE_KEY is set (secret key missing)', () => {
    set('NODE_ENV', 'production');
    set('SUPABASE_URL', 'https://project.supabase.co');
    set('STRIPE_SECRET_KEY', undefined);
    set('STRIPE_PUBLISHABLE_KEY', 'pk_test_123');
    expect(() => assertProductionConfig()).toThrow(
      /Stripe Financial Connections partially configured/,
    );
  });

  it('passes in production with both Stripe FC vars set together', () => {
    set('NODE_ENV', 'production');
    set('SUPABASE_URL', 'https://project.supabase.co');
    set('STRIPE_SECRET_KEY', 'sk_test_123');
    set('STRIPE_PUBLISHABLE_KEY', 'pk_test_123');
    expect(() => assertProductionConfig()).not.toThrow();
  });
});

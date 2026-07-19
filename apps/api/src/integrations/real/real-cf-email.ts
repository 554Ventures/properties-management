// Real email adapter against the Cloudflare Email Service REST API (plain
// fetch — no SDK dependency; the Fastify API runs in a Cloudflare Container,
// not a Worker, so the `send_email` binding doesn't apply). Selected by
// integrations/factory.ts only when CLOUDFLARE_EMAIL_API_TOKEN,
// CLOUDFLARE_ACCOUNT_ID, and EMAIL_FROM are all set. EMAIL_FROM's domain must
// be onboarded to Email Sending (account setup §9). All provider specifics
// live here: the `from` object uses `address` (not `email`), reply-to would be
// snake_case `reply_to`, and the response carries no message id — `result` is
// `{delivered, permanent_bounces, queued}` — so a messageId is synthesized.
// Throws on failure; callers own fire-and-forget/never-throw semantics.
import type { EmailAdapter } from '../types';

interface CfEmailResponse {
  success: boolean;
  errors?: Array<{ message?: string }>;
  result?: { delivered?: string[]; permanent_bounces?: string[]; queued?: string[] };
}

export function createCfEmailAdapter(): EmailAdapter {
  const token = process.env.CLOUDFLARE_EMAIL_API_TOKEN ?? '';
  const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const from = process.env.EMAIL_FROM ?? '';
  const sendUrl = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/email/sending/send`;

  return {
    async send({ to, subject, body }) {
      const res = await fetch(sendUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to,
          from: { address: from, name: '554 Properties' },
          subject,
          text: body,
        }),
      });
      if (!res.ok) {
        throw new Error(`[email] send failed for ${to}: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as CfEmailResponse;
      if (!data.success) {
        const detail = data.errors?.map((e) => e.message).join('; ') || 'unknown error';
        throw new Error(`[email] send failed for ${to}: ${detail}`);
      }
      const recipient = data.result?.delivered?.[0] ?? data.result?.queued?.[0] ?? to;
      return { messageId: `cf_email_${recipient}` };
    },
  };
}

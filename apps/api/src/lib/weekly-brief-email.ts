// The weekly brief's rendered email. The brief has no card in the app any
// more (removed from the Dashboard as a distraction), so this email — not a
// teaser pointing at one — is the digest: headline, summary, every action
// item, then the link to the archived report.
//
// Plain text only, deliberately: the Cloudflare Email Service adapter sends
// `text` (integrations/real/real-cf-email.ts), and the brief is model-authored
// prose, so keeping it out of HTML keeps composed content from carrying markup
// into an inbox.
import type { WeeklyBriefData } from '@hearth/shared';
import { configuredPublicAppUrl } from './public-url';

export interface WeeklyBriefEmail {
  subject: string;
  body: string;
}

/**
 * Build the weekly-brief email from a contract-valid snapshot. Pure — the only
 * ambient input is PUBLIC_APP_URL, and without it the body degrades to
 * link-free copy rather than pointing at a host we can't know here.
 */
export function buildWeeklyBriefEmail(
  reportId: string,
  brief: WeeklyBriefData,
): WeeklyBriefEmail {
  const lines: string[] = [brief.weekLabel, '', brief.headline.trim()];

  const summary = brief.summary.trim();
  if (summary) lines.push('', summary);

  // Action labels ride along as plain text — an email can't execute them, and
  // the report link below is one tap from the real control.
  const items = brief.items.filter((item) => item.text.trim().length > 0);
  if (items.length > 0) {
    lines.push('', 'This week:');
    for (const item of items) {
      const suffix = item.action ? ` (${item.action.label})` : '';
      lines.push(`  • ${item.text.trim()}${suffix}`);
    }
  }

  const baseUrl = configuredPublicAppUrl();
  lines.push(
    '',
    baseUrl
      ? `Read the full brief: ${baseUrl}/reports/${reportId}`
      : 'Open 554 Properties → Reports for the full brief.',
    '',
    'Weekly briefs can be turned off in Settings → Notifications.',
  );

  return { subject: `Weekly brief — ${brief.weekLabel}`, body: lines.join('\n') };
}

// Unit tests for the action_card allowlist: only the write routes the
// assistant legitimately proposes may execute; report emailing (exfil
// channel), settings, PATCH/DELETE, and off-app navigation are refused.
import { describe, expect, it } from 'vitest';
import { isAllowedApiCall, isAllowedNavigate } from '../components/chat/actionAllowlist';

describe('isAllowedApiCall', () => {
  it('allows the assistant-proposed write routes, including real cuid ids', () => {
    expect(isAllowedApiCall('POST', '/rent/reminders')).toBe(true);
    expect(isAllowedApiCall('POST', '/rent/payments')).toBe(true);
    expect(isAllowedApiCall('POST', '/transactions')).toBe(true);
    expect(isAllowedApiCall('POST', '/transactions/clx0f2q9d0001abcdWXYZ123/confirm')).toBe(true);
    expect(isAllowedApiCall('POST', '/reports/generate')).toBe(true);
    expect(isAllowedApiCall('POST', '/insights/cm4ktz8yq000108l5f1a2b3c4/dismiss')).toBe(true);
  });

  it('ignores the query string when matching the path', () => {
    expect(isAllowedApiCall('POST', '/reports/generate?type=schedule_e')).toBe(true);
  });

  it('refuses report emailing, settings, and any PATCH/DELETE', () => {
    expect(isAllowedApiCall('POST', '/reports/r1/email')).toBe(false);
    expect(isAllowedApiCall('POST', '/settings/account')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/settings/account')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/transactions')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/transactions/t1/confirm')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/transactions/t1')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/properties/p1')).toBe(false);
  });

  it('refuses lookalike paths that only prefix or extend an allowed route', () => {
    expect(isAllowedApiCall('POST', '/rent/reminders/extra')).toBe(false);
    expect(isAllowedApiCall('POST', '/transactions/../settings/account')).toBe(false);
    expect(isAllowedApiCall('POST', '/transactions/a/b/confirm')).toBe(false);
    expect(isAllowedApiCall('POST', '/reports/generate/email')).toBe(false);
  });
});

describe('isAllowedNavigate', () => {
  it('allows in-app absolute paths only', () => {
    expect(isAllowedNavigate('/reports/r1')).toBe(true);
    expect(isAllowedNavigate('/money?filter=unconfirmed')).toBe(true);
  });

  it('refuses protocol-relative and external destinations', () => {
    expect(isAllowedNavigate('//evil.example.com/phish')).toBe(false);
    expect(isAllowedNavigate('https://evil.example.com')).toBe(false);
    expect(isAllowedNavigate('javascript:alert(1)')).toBe(false);
    expect(isAllowedNavigate('reports/r1')).toBe(false);
  });
});

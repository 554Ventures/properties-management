// Unit tests for the action_card allowlist: only the write routes the
// assistant legitimately proposes may execute — add/edit for properties,
// tenants, contractors and transactions included; report emailing (exfil channel),
// settings, un-listed PATCH, all DELETE, and off-app navigation are refused.
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

  it('allows adding and editing properties, tenants, contractors and transactions', () => {
    expect(isAllowedApiCall('POST', '/properties')).toBe(true);
    expect(isAllowedApiCall('PATCH', '/properties/clx0f2q9d0001abcdWXYZ123')).toBe(true);
    expect(isAllowedApiCall('POST', '/tenants')).toBe(true);
    expect(isAllowedApiCall('PATCH', '/tenants/cm4ktz8yq000108l5f1a2b3c4')).toBe(true);
    expect(isAllowedApiCall('POST', '/contractors')).toBe(true);
    expect(isAllowedApiCall('PATCH', '/contractors/cm4ktz8yq000108l5f1a2b3c4')).toBe(true);
    expect(isAllowedApiCall('PATCH', '/transactions/clx0f2q9d0001abcdWXYZ123')).toBe(true);
  });

  it('ignores the query string when matching the path', () => {
    expect(isAllowedApiCall('POST', '/reports/generate?type=schedule_e')).toBe(true);
  });

  it('refuses report emailing, settings, un-listed PATCH, and all DELETE', () => {
    expect(isAllowedApiCall('POST', '/reports/r1/email')).toBe(false);
    expect(isAllowedApiCall('POST', '/settings/account')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/settings/account')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/transactions')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/transactions/t1/confirm')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/properties')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/tenants')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/leases/l1')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/transactions/t1')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/properties/p1')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/tenants/t1')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/contractors/c1')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/contractors')).toBe(false);
    expect(isAllowedApiCall('POST', '/contractors/c1/jobs')).toBe(false);
    expect(isAllowedApiCall('POST', '/contractors/c1/restore')).toBe(false);
  });

  it('refuses lookalike paths that only prefix or extend an allowed route', () => {
    expect(isAllowedApiCall('POST', '/rent/reminders/extra')).toBe(false);
    expect(isAllowedApiCall('POST', '/transactions/../settings/account')).toBe(false);
    expect(isAllowedApiCall('POST', '/transactions/a/b/confirm')).toBe(false);
    expect(isAllowedApiCall('POST', '/reports/generate/email')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/properties/p1/units/u1')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/tenants/t1/leases')).toBe(false);
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

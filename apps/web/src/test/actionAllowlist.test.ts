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
    expect(isAllowedApiCall('POST', '/rent/payments/cm4ktz8yq000108l5f1a2b3c4/late-fee')).toBe(true);
  });

  it('allows applying a late fee but never waiving it (DELETE stays excluded)', () => {
    expect(isAllowedApiCall('DELETE', '/rent/payments/rp1/late-fee')).toBe(false);
    expect(isAllowedApiCall('POST', '/rent/payments/rp1/late-fee/extra')).toBe(false);
  });

  it('allows adding and editing properties, units, tenants, contractors and transactions', () => {
    expect(isAllowedApiCall('POST', '/properties')).toBe(true);
    expect(isAllowedApiCall('PATCH', '/properties/clx0f2q9d0001abcdWXYZ123')).toBe(true);
    expect(isAllowedApiCall('POST', '/properties/clx0f2q9d0001abcdWXYZ123/units')).toBe(true);
    expect(isAllowedApiCall('PATCH', '/units/cm4ktz8yq000108l5f1a2b3c4')).toBe(true);
    expect(isAllowedApiCall('POST', '/tenants')).toBe(true);
    expect(isAllowedApiCall('PATCH', '/tenants/cm4ktz8yq000108l5f1a2b3c4')).toBe(true);
    expect(isAllowedApiCall('POST', '/contractors')).toBe(true);
    expect(isAllowedApiCall('PATCH', '/contractors/cm4ktz8yq000108l5f1a2b3c4')).toBe(true);
    expect(isAllowedApiCall('PATCH', '/transactions/clx0f2q9d0001abcdWXYZ123')).toBe(true);
  });

  it('allows adding a mortgage, re-checkpointing it, and recording a valuation', () => {
    expect(isAllowedApiCall('POST', '/properties/clx0f2q9d0001abcdWXYZ123/mortgages')).toBe(true);
    expect(isAllowedApiCall('PATCH', '/mortgages/cm4ktz8yq000108l5f1a2b3c4')).toBe(true);
    expect(isAllowedApiCall('POST', '/properties/clx0f2q9d0001abcdWXYZ123/valuations')).toBe(true);
  });

  it('refuses mortgage/valuation deletes, archive/restore, and lookalike paths', () => {
    expect(isAllowedApiCall('DELETE', '/mortgages/m1')).toBe(false);
    expect(isAllowedApiCall('POST', '/mortgages/m1/restore')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/valuations/v1')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/properties/p1/mortgages')).toBe(false);
    expect(isAllowedApiCall('POST', '/properties/p1/mortgages/extra')).toBe(false);
    expect(isAllowedApiCall('POST', '/mortgages')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/mortgages')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/properties/p1/valuations')).toBe(false);
    expect(isAllowedApiCall('POST', '/properties/p1/valuations/extra')).toBe(false);
    expect(isAllowedApiCall('POST', '/valuations')).toBe(false);
  });

  it('allows creating a recurring template but never editing, archiving or restoring one', () => {
    expect(isAllowedApiCall('POST', '/recurring-templates')).toBe(true);
    expect(isAllowedApiCall('PATCH', '/recurring-templates/rt1')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/recurring-templates/rt1')).toBe(false);
    expect(isAllowedApiCall('POST', '/recurring-templates/rt1/restore')).toBe(false);
    expect(isAllowedApiCall('POST', '/recurring-templates/rt1')).toBe(false);
    expect(isAllowedApiCall('GET', '/recurring-templates')).toBe(false);
  });

  it('allows creating, editing and renewing leases, and adding a tenant to one', () => {
    expect(isAllowedApiCall('POST', '/leases')).toBe(true);
    expect(isAllowedApiCall('PATCH', '/leases/clx0f2q9d0001abcdWXYZ123')).toBe(true);
    expect(isAllowedApiCall('POST', '/leases/cm4ktz8yq000108l5f1a2b3c4/renewal')).toBe(true);
    expect(isAllowedApiCall('POST', '/leases/cm4ktz8yq000108l5f1a2b3c4/tenants')).toBe(true);
  });

  it('refuses lease termination, tenant removal and lookalike lease paths', () => {
    // Ending a tenancy is not undoable from the UI — it stays a decision the
    // user makes on the lease itself, never a chat button.
    expect(isAllowedApiCall('POST', '/leases/l1/terminate')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/leases/l1/tenants/t1')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/leases/l1/tenants/t1')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/leases/l1')).toBe(false);
    // The id pattern must not cross a `/`.
    expect(isAllowedApiCall('POST', '/leases/l1/renewal/extra')).toBe(false);
    expect(isAllowedApiCall('POST', '/leases/l1/esign')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/leases')).toBe(false);
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
    // PATCH /leases/:id used to be refused here purely because leases had no
    // tools; it is now deliberately allowed (see the lease cases above), while
    // the collection path stays refused like every other.
    expect(isAllowedApiCall('PATCH', '/leases')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/transactions/t1')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/properties/p1')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/units/u1')).toBe(false);
    expect(isAllowedApiCall('POST', '/units/u1/restore')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/units')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/tenants/t1')).toBe(false);
    expect(isAllowedApiCall('DELETE', '/contractors/c1')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/contractors')).toBe(false);
    expect(isAllowedApiCall('POST', '/contractors/c1/jobs')).toBe(false);
    expect(isAllowedApiCall('POST', '/contractors/c1/restore')).toBe(false);
  });

  it('allows creating and editing work orders but never archiving/restoring one', () => {
    expect(isAllowedApiCall('POST', '/work-orders')).toBe(true);
    expect(isAllowedApiCall('PATCH', '/work-orders/cm4ktz8yq000108l5f1a2b3c4')).toBe(true);
    expect(isAllowedApiCall('DELETE', '/work-orders/wo1')).toBe(false);
    expect(isAllowedApiCall('POST', '/work-orders/wo1/restore')).toBe(false);
    expect(isAllowedApiCall('POST', '/work-orders/wo1')).toBe(false);
    expect(isAllowedApiCall('GET', '/work-orders')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/work-orders')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/work-orders/wo1/expense')).toBe(false);
  });

  it('refuses lookalike paths that only prefix or extend an allowed route', () => {
    expect(isAllowedApiCall('POST', '/rent/reminders/extra')).toBe(false);
    expect(isAllowedApiCall('POST', '/transactions/../settings/account')).toBe(false);
    expect(isAllowedApiCall('POST', '/transactions/a/b/confirm')).toBe(false);
    expect(isAllowedApiCall('POST', '/reports/generate/email')).toBe(false);
    expect(isAllowedApiCall('PATCH', '/properties/p1/units/u1')).toBe(false);
    expect(isAllowedApiCall('POST', '/properties/p1/units/extra')).toBe(false);
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

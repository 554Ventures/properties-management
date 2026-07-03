// (c) Tenant status precedence: late > renew_soon > current.
import { describe, expect, it } from 'vitest';
import { CHEN_NAME, NOVAK_NAME, OKAFOR_NAME, PARK_NAME } from '../../prisma/seed-constants';
import { getDemoAccountId } from '../plugins/auth';
import * as tenantService from '../services/tenant.service';

describe('tenantService.list statuses', () => {
  it('derives late / renew_soon / current per §4', async () => {
    const accountId = await getDemoAccountId();
    const rows = await tenantService.list(accountId);
    const byName = new Map(rows.map((r) => [r.fullName, r]));

    expect(byName.get(CHEN_NAME)?.status).toBe('renew_soon'); // lease ends today + 45d
    expect(byName.get(NOVAK_NAME)?.status).toBe('renew_soon'); // today + 58d
    expect(byName.get(OKAFOR_NAME)?.status).toBe('late'); // 6 days late
    expect(byName.get(PARK_NAME)?.status).toBe('late'); // 3 days late
    expect(byName.get('J. Rivera')?.status).toBe('current');

    // Lease context is populated for occupied tenants.
    const chen = byName.get(CHEN_NAME);
    expect(chen?.rentCents).toBe(117500);
    expect(chen?.propertyLabel).toBe('140 Willow Way');
  });
});

// Regression guard for `describeCadence` (recurring templates, PLAN-REAL-EQUITY
// §2 Phase 2b). `anchorDate` is a plain `YYYY-MM-DD` calendar date with no time
// and no zone — reading it through `new Date(anchorDate)` (even with UTC
// getters) is a second, independent way to get the day wrong once any part of
// the pipeline treats it as an instant. These assertions run under a
// non-UTC `TZ` on purpose: the suite's default `TZ=UTC` (vite.config.ts) would
// let a Date-parsing implementation pass by accident, masking exactly the bug
// under review.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeCadence } from '../lib/format';

describe('describeCadence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads the day for a monthly cadence from the string, unaffected by the local timezone', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(describeCadence('monthly', '2026-09-01')).toBe('Monthly, on the 1st');
  });

  it('reads the day for a quarterly cadence from the string, unaffected by the local timezone', () => {
    vi.stubEnv('TZ', 'Pacific/Kiritimati'); // UTC+14 — as far east as timezones go
    expect(describeCadence('quarterly', '2026-01-15')).toBe('Quarterly, on the 15th');
  });

  it('reads the day and month for an annual cadence from the string, unaffected by the local timezone', () => {
    vi.stubEnv('TZ', 'Pacific/Midway'); // UTC-11 — as far west as timezones go
    expect(describeCadence('annual', '2026-03-22')).toBe('Annually, on Mar 22');
  });

  it('still reads correctly under UTC (the default test timezone)', () => {
    expect(describeCadence('monthly', '2026-09-01')).toBe('Monthly, on the 1st');
  });
});

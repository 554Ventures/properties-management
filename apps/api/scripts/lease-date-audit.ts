// Read-only audit: which stored lease dates are NOT at their account
// timezone's local midnight.
//
// Lease start/end dates are calendar days, and every rent derivation buckets
// them with startOfDayInTz(account.timezone). A lease entered before the write
// boundary normalized its dates can therefore sit at, say, UTC midnight —
// which in New York resolves to the *previous* local day, quietly shifting a
// lease's first/last day by one and mis-prorating the month either side of a
// switchover.
//
// This script only LOOKS. There is no --fix, and adding one would be wrong:
// rewriting a lease date changes what a tenant is billed, and the "probably
// meant" column below is an inference (the calendar day the stored instant
// names in UTC — i.e. what a client that serialized a date picker as UTC
// midnight would have written), not a fact recoverable from the row. Whether a
// given lease should move, and what to do about charges already materialized
// or paid against the old dates, is the landlord's call — made lease by lease,
// through the audited lease-update path, not by a script.
//
// Usage (from apps/api; DATABASE_URL selects the database, .env is the
// default — point it at a read replica or a copy when auditing production):
//   npx tsx scripts/lease-date-audit.ts
//   npm run audit:lease-dates --workspace apps/api

import { startOfDayInTz, wallClockParts } from '../src/lib/dates';
import { prisma } from '../src/lib/prisma';
import { loadApiEnv } from './pg';

loadApiEnv();

/** "YYYY-MM-DD" of an instant on `tz`'s wall calendar. */
function localDay(at: Date, tz: string): string {
  const p = wallClockParts(tz, at);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The calendar day the stored instant names in UTC — what a client sending a
 *  date picker's value as UTC midnight would have written. */
function writtenDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

const leases = await prisma.lease.findMany({
  include: {
    unit: {
      include: {
        property: { include: { account: { select: { id: true, name: true, timezone: true } } } },
      },
    },
  },
  orderBy: [{ unitId: 'asc' }, { startDate: 'asc' }],
});

interface Finding {
  leaseId: string;
  account: string;
  tz: string;
  unit: string;
  field: 'startDate' | 'endDate';
  stored: string;
  resolvesTo: string;
  probablyMeant: string;
  shiftedDays: number;
}

const DAY_MS = 86_400_000;
const findings: Finding[] = [];

for (const lease of leases) {
  const { property } = lease.unit;
  const tz = property.account.timezone;
  const unit = `${property.nickname ?? property.addressLine1} · ${lease.unit.label}`;
  for (const field of ['startDate', 'endDate'] as const) {
    const stored = lease[field];
    if (stored.getTime() === startOfDayInTz(stored, tz).getTime()) continue;
    const resolvesTo = localDay(stored, tz);
    const probablyMeant = writtenDay(stored);
    findings.push({
      leaseId: lease.id,
      account: property.account.name,
      tz,
      unit,
      field,
      stored: stored.toISOString(),
      resolvesTo,
      probablyMeant,
      shiftedDays: Math.round(
        (Date.parse(`${probablyMeant}T00:00:00Z`) - Date.parse(`${resolvesTo}T00:00:00Z`)) / DAY_MS,
      ),
    });
  }
}

console.log(`[lease-date-audit] ${leases.length} lease(s) examined (read-only)\n`);

if (findings.length === 0) {
  console.log('Every lease date is already at its account timezone\'s local midnight.');
} else {
  for (const f of findings) {
    console.log(`lease ${f.leaseId}  [${f.account} · ${f.tz}]`);
    console.log(`  unit           ${f.unit}`);
    console.log(`  ${f.field.padEnd(14)} stored ${f.stored}`);
    console.log(`  resolves to    ${f.resolvesTo} (local)`);
    console.log(
      `  probably meant ${f.probablyMeant} (local)` +
        (f.shiftedDays === 0 ? ' — same day, storage is just off midnight' : `  ← shifted ${f.shiftedDays > 0 ? '−' : '+'}${Math.abs(f.shiftedDays)} day`),
    );
    console.log('');
  }
  const shifted = findings.filter((f) => f.shiftedDays !== 0);
  const leasesAffected = new Set(findings.map((f) => f.leaseId)).size;
  console.log(
    `${findings.length} date(s) across ${leasesAffected} lease(s) are not at local midnight; ` +
      `${shifted.length} of them land on a different local day than they name.`,
  );
  console.log(
    'A different local day is the one that changes money: it moves a lease\'s first/last\n' +
      'covered day, so proration and any switchover blend read one day off. Repair is\n' +
      'deliberately not automated — see this file\'s header.',
  );
}

await prisma.$disconnect();

// Pure-logic coverage for attention.ts: insight/task matching, merge/sort
// order, and parity spot-checks against the former PropertyTasks derivation
// loop (badge/sentence strings must match exactly since this module is the
// data source NeedsAttention.tsx renders from).
import type { Insight } from '@hearth/shared';
import { describe, expect, it } from 'vitest';
import {
  deriveTasks,
  insightMatchesTask,
  mergeAttention,
  type DerivedTask,
} from '../components/property/attention';
import { isoIn, makeLease, makeTenant, makeUnit } from './propertyHubFixtures';

function makeInsight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: 'i1',
    accountId: 'acc1',
    scope: 'tenant',
    type: 'late_rent',
    severity: 'warning',
    title: 'Default insight title',
    body: 'Default insight body.',
    actionLabel: null,
    actionTarget: null,
    action: null,
    propertyId: 'p1',
    tenantId: null,
    leaseId: null,
    dedupeKey: 'default:key',
    status: 'active',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('deriveTasks', () => {
  it('emits a late-rent row with the partial-payment sentence and daysLate badge', () => {
    const park = makeTenant('t-park', 'D. Park');
    const lease = makeLease('l1', 'u1', 140000, [park]);
    const unit = makeUnit('u1', 'Unit A', {
      status: 'occupied',
      currentLease: lease,
      rent: {
        period: '2026-07',
        status: 'late',
        daysLate: 5,
        paidCents: 50000,
        amountCents: 140000,
        dueDate: isoIn(-5),
      },
    });

    const tasks = deriveTasks([unit]);
    const rentTask = tasks.find((t) => t.kind === 'rent');
    expect(rentTask).toEqual({
      kind: 'rent',
      unitId: 'u1',
      leaseId: 'l1',
      tenantIds: ['t-park'],
      severity: 0,
      tone: 'danger',
      badge: '5 days late',
      sentence: 'D. Park · Unit A — 5 days late · $500.00 of $1,400.00 received',
      affordance: { type: 'tracker-link', period: '2026-07' },
    });
  });

  it('emits a month-to-month row for a lapsed lease', () => {
    const novak = makeTenant('t-novak', 'S. Novak');
    const lease = makeLease('l2', 'u2', 120000, [novak], { endDate: isoIn(-4.4) });
    const unit = makeUnit('u2', 'Unit B', { status: 'occupied', currentLease: lease });

    const tasks = deriveTasks([unit]);
    const renewalTask = tasks.find((t) => t.kind === 'renewal');
    expect(renewalTask).toMatchObject({
      kind: 'renewal',
      unitId: 'u2',
      leaseId: 'l2',
      severity: 0,
      tone: 'danger',
      badge: 'Month-to-month',
      sentence: "S. Novak's lease on Unit B ended 4 days ago — now running month-to-month",
      affordance: { type: 'draft-renewal', lease },
    });
  });

  it('emits an awaiting-signature row when a pending renewal lease exists', () => {
    const quinn = makeTenant('t-quinn', 'P. Quinn');
    const lease = makeLease('l6', 'u6', 110000, [quinn], { endDate: isoIn(29.5) });
    const pendingLease = makeLease('l6p', 'u6', 115000, [quinn], {
      startDate: isoIn(30),
      endDate: isoIn(395),
      status: 'pending_signature',
    });
    const unit = makeUnit('u6', 'Unit F', {
      status: 'occupied',
      currentLease: lease,
      pendingLease,
    });

    const tasks = deriveTasks([unit]);
    const renewalTask = tasks.find((t) => t.kind === 'renewal');
    expect(renewalTask).toEqual({
      kind: 'renewal',
      unitId: 'u6',
      leaseId: 'l6',
      tenantIds: ['t-quinn'],
      severity: 2,
      tone: 'neutral',
      badge: 'Awaiting signature',
      sentence: "P. Quinn's renewal on Unit F is awaiting signature",
      affordance: null,
    });
  });

  it('emits a vacancy row for a vacant unit with no current lease', () => {
    const unit = makeUnit('u3', 'Unit C', { status: 'vacant' });

    const tasks = deriveTasks([unit]);
    expect(tasks).toEqual([
      {
        kind: 'vacancy',
        unitId: 'u3',
        leaseId: null,
        tenantIds: [],
        severity: 1,
        tone: 'warning',
        badge: 'Vacant',
        sentence: 'Unit C is vacant',
        affordance: { type: 'create-lease', unit },
      },
    ]);
  });

  it('skips archived units entirely', () => {
    const unit = makeUnit('u4', 'Unit D', {
      archivedAt: '2025-06-01T00:00:00.000Z',
      status: 'vacant',
    });
    expect(deriveTasks([unit])).toEqual([]);
  });
});

describe('insightMatchesTask', () => {
  const rentTask: DerivedTask = {
    kind: 'rent',
    unitId: 'u1',
    leaseId: 'l1',
    tenantIds: ['t1', 't2'],
    severity: 0,
    tone: 'danger',
    badge: 'Late',
    sentence: 'x',
    affordance: null,
  };

  const renewalTask: DerivedTask = {
    kind: 'renewal',
    unitId: 'u2',
    leaseId: 'l2',
    tenantIds: ['t3'],
    severity: 1,
    tone: 'warning',
    badge: 'Lease ending',
    sentence: 'y',
    affordance: null,
  };

  it('matches late_rent by leaseId', () => {
    const insight = makeInsight({ type: 'late_rent', leaseId: 'l1', tenantId: null });
    expect(insightMatchesTask(insight, rentTask)).toBe(true);
  });

  it('matches late_rent by tenantId when leaseId differs (renewal switchover)', () => {
    const insight = makeInsight({ type: 'late_rent', leaseId: 'l-old', tenantId: 't2' });
    expect(insightMatchesTask(insight, rentTask)).toBe(true);
  });

  it('does not match late_rent when neither leaseId nor tenantId line up', () => {
    const insight = makeInsight({ type: 'late_rent', leaseId: 'l-other', tenantId: 't-other' });
    expect(insightMatchesTask(insight, rentTask)).toBe(false);
  });

  it('matches renewal_window by leaseId', () => {
    const insight = makeInsight({ type: 'renewal_window', leaseId: 'l2', tenantId: null });
    expect(insightMatchesTask(insight, renewalTask)).toBe(true);
  });

  it('matches renewal_window with a null leaseId defensively', () => {
    const insight = makeInsight({ type: 'renewal_window', leaseId: null });
    expect(insightMatchesTask(insight, renewalTask)).toBe(true);
  });

  it('never matches across kinds (renewal_window vs rent task)', () => {
    const insight = makeInsight({ type: 'renewal_window', leaseId: 'l1' });
    expect(insightMatchesTask(insight, rentTask)).toBe(false);
  });

  it('returns false for unrelated insight types', () => {
    const insight = makeInsight({ type: 'expense_spike', leaseId: 'l1' });
    expect(insightMatchesTask(insight, rentTask)).toBe(false);
  });
});

describe('mergeAttention', () => {
  const rentTaskA: DerivedTask = {
    kind: 'rent',
    unitId: 'u1',
    leaseId: 'l1',
    tenantIds: ['t1'],
    severity: 0,
    tone: 'danger',
    badge: '3 days late',
    sentence: 'D. Park · Unit A — 3 days late',
    affordance: { type: 'tracker-link', period: '2026-07' },
  };

  it('merges a late_rent insight onto its rent task by leaseId, derived fields win', () => {
    const insight = makeInsight({
      id: 'i-late',
      type: 'late_rent',
      leaseId: 'l1',
      tenantId: null,
      title: 'D. Park is 3 days late on rent',
      body: 'Rent of $1,400.00 was due on the 1st.',
    });

    const rows = mergeAttention([rentTaskA], [insight]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'task:rent:u1',
      severity: 0,
      tone: 'danger',
      badge: '3 days late',
      sentence: 'D. Park · Unit A — 3 days late',
      insight,
    });
    expect(rows[0]?.detail).toBeUndefined();
  });

  it('merges via tenantId fallback when the insight leaseId differs (switchover)', () => {
    const insight = makeInsight({
      id: 'i-late',
      type: 'late_rent',
      leaseId: 'l-outgoing',
      tenantId: 't1',
    });

    const rows = mergeAttention([rentTaskA], [insight]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.insight).toBe(insight);
    expect(rows[0]?.task).toBe(rentTaskA);
  });

  it('leaves the task row plain when no insight matches', () => {
    const insight = makeInsight({ id: 'i-other', type: 'late_rent', leaseId: 'l-other', tenantId: 't-other' });

    const rows = mergeAttention([rentTaskA], [insight]);
    expect(rows).toHaveLength(2);
    const taskRow = rows.find((r) => r.key === 'task:rent:u1');
    expect(taskRow?.insight).toBeUndefined();
    expect(taskRow).toMatchObject({
      severity: 0,
      tone: 'danger',
      badge: '3 days late',
      sentence: 'D. Park · Unit A — 3 days late',
    });
  });

  it('suppresses a renewal_window insight with a null leaseId against a derived renewal row, producing no row of its own', () => {
    const renewalTask: DerivedTask = {
      kind: 'renewal',
      unitId: 'u2',
      leaseId: 'l2',
      tenantIds: ['t2'],
      severity: 1,
      tone: 'warning',
      badge: 'Lease ending',
      sentence: "S. Novak's lease on Unit B ends in 30 days",
      affordance: null,
    };
    const insight = makeInsight({
      id: 'i-renewal',
      type: 'renewal_window',
      leaseId: null,
    });

    const rows = mergeAttention([renewalTask], [insight]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('task:renewal:u2');
    expect(rows[0]?.insight).toBeUndefined();
  });

  it('turns an expense_spike insight into an insight-only row with title/body and mapped severity/tone', () => {
    const insight = makeInsight({
      id: 'i-spike',
      type: 'expense_spike',
      severity: 'warning',
      title: 'Utilities spending spiked at Birch Lane',
      body: 'Utilities came in at $640 this month vs a $380 three-month average.',
      leaseId: null,
      tenantId: null,
    });

    const rows = mergeAttention([], [insight]);
    expect(rows).toEqual([
      {
        key: 'insight:i-spike',
        severity: 1,
        tone: 'warning',
        badge: 'Needs attention',
        sentence: 'Utilities spending spiked at Birch Lane',
        detail: 'Utilities came in at $640 this month vs a $380 three-month average.',
        insight,
      },
    ]);
  });

  it('sorts danger task, warning insight, neutral task, positive insight in that order; positive sorts last', () => {
    const dangerTask: DerivedTask = {
      kind: 'rent',
      unitId: 'u-danger',
      leaseId: 'l-danger',
      tenantIds: [],
      severity: 0,
      tone: 'danger',
      badge: 'Failed',
      sentence: 'danger task',
      affordance: null,
    };
    const neutralTask: DerivedTask = {
      kind: 'renewal',
      unitId: 'u-neutral',
      leaseId: 'l-neutral',
      tenantIds: [],
      severity: 2,
      tone: 'neutral',
      badge: 'Awaiting signature',
      sentence: 'neutral task',
      affordance: null,
    };
    const warningInsight = makeInsight({
      id: 'i-warning',
      type: 'expense_spike',
      severity: 'warning',
      leaseId: null,
      tenantId: null,
    });
    const positiveInsight = makeInsight({
      id: 'i-positive',
      type: 'underperforming_property',
      severity: 'positive',
      leaseId: null,
      tenantId: null,
    });

    const rows = mergeAttention(
      [dangerTask, neutralTask],
      [positiveInsight, warningInsight],
    );

    expect(rows.map((r) => r.key)).toEqual([
      'task:rent:u-danger',
      'insight:i-warning',
      'task:renewal:u-neutral',
      'insight:i-positive',
    ]);
    expect(rows[rows.length - 1]?.severity).toBe(3);
  });

  it('never attaches one insight to two rent rows', () => {
    const taskA: DerivedTask = {
      kind: 'rent',
      unitId: 'u1',
      leaseId: 'l1',
      tenantIds: ['t-shared'],
      severity: 0,
      tone: 'danger',
      badge: 'Late',
      sentence: 'task A',
      affordance: null,
    };
    const taskB: DerivedTask = {
      kind: 'rent',
      unitId: 'u2',
      leaseId: 'l2',
      tenantIds: ['t-shared'],
      severity: 0,
      tone: 'danger',
      badge: 'Late',
      sentence: 'task B',
      affordance: null,
    };
    // Matches both tasks via the shared tenantId — should attach only once,
    // to the first task in order, leaving the second plain.
    const insight = makeInsight({
      id: 'i-shared',
      type: 'late_rent',
      leaseId: null,
      tenantId: 't-shared',
    });

    const rows = mergeAttention([taskA, taskB], [insight]);
    expect(rows).toHaveLength(2);
    const rowA = rows.find((r) => r.key === 'task:rent:u1');
    const rowB = rows.find((r) => r.key === 'task:rent:u2');
    expect(rowA?.insight).toBe(insight);
    expect(rowB?.insight).toBeUndefined();
  });

  it('a leaseId match takes precedence over the tenantId fallback across units (same tenant, two late leases)', () => {
    // Tenant T is on two active late leases in the same property: Unit A's
    // lease l1 and Unit B's lease l2. The single late_rent insight names l2
    // explicitly — it must attach to Unit B, not fall through to Unit A via
    // the tenantId fallback just because Unit A is unit-first.
    const unitA: DerivedTask = {
      kind: 'rent',
      unitId: 'u-a',
      leaseId: 'l1',
      tenantIds: ['t-shared'],
      severity: 0,
      tone: 'danger',
      badge: 'Late',
      sentence: 'Unit A late',
      affordance: null,
    };
    const unitB: DerivedTask = {
      kind: 'rent',
      unitId: 'u-b',
      leaseId: 'l2',
      tenantIds: ['t-shared'],
      severity: 0,
      tone: 'danger',
      badge: 'Late',
      sentence: 'Unit B late',
      affordance: null,
    };
    const insight = makeInsight({
      id: 'i-l2',
      type: 'late_rent',
      leaseId: 'l2',
      tenantId: 't-shared',
    });

    const rows = mergeAttention([unitA, unitB], [insight]);
    const rowA = rows.find((r) => r.key === 'task:rent:u-a');
    const rowB = rows.find((r) => r.key === 'task:rent:u-b');
    expect(rowB?.insight).toBe(insight);
    expect(rowA?.insight).toBeUndefined();
  });
});

// Pure logic (no JSX): derives the property page's "needs attention" tasks
// from a unit list (rent trouble / lease expiry / vacancy — the same rules as
// the former PropertyTasks derivation loop, ported here as data and rendered
// by NeedsAttention.tsx) and merges them with backend AI insights into one
// deduplicated, severity-sorted list.
// Permission gating (canTenants) is intentionally NOT applied here — every
// affordance is always emitted as data; the rendering component decides
// whether to show it.
import { RENEW_SOON_DAYS, formatUsd } from '@hearth/shared';
import type { Insight, LeaseWithTenants, PropertyDetailUnit } from '@hearth/shared';
import { daysUntil } from '../../lib/format';
import { severityBadge } from '../ai/InsightCard';
import type { BadgeTone } from '../ui/StatusBadge';

export type TaskAffordance =
  | { type: 'tracker-link'; period: string }
  | { type: 'draft-renewal'; lease: LeaseWithTenants }
  | { type: 'create-lease'; unit: PropertyDetailUnit };

export interface DerivedTask {
  kind: 'rent' | 'renewal' | 'vacancy';
  unitId: string;
  leaseId: string | null; // currentLease.id when present
  tenantIds: string[]; // currentLease tenant ids ([] when none)
  severity: 0 | 1 | 2; // 0 danger · 1 warning · 2 neutral
  tone: BadgeTone;
  badge: string;
  sentence: string;
  affordance: TaskAffordance | null;
}

export interface AttentionRow {
  key: string; // `task:${kind}:${unitId}` or `insight:${insight.id}`
  severity: 0 | 1 | 2 | 3; // 3 = positive insights, sorted last
  tone: BadgeTone;
  badge: string;
  sentence: string;
  detail?: string; // insight.body — only on insight-only rows
  task?: DerivedTask;
  insight?: Insight; // present → row is AI-sourced or AI-enriched
}

const daysLabel = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

const INSIGHT_SEVERITY_RANK: Record<Insight['severity'], 1 | 2 | 3> = {
  warning: 1,
  info: 2,
  positive: 3,
};

/**
 * Port of the former PropertyTasks derivation loop (now NeedsAttention.tsx),
 * as data: filters archived units, then for each remaining unit emits at
 * most one rent row, one lease-expiry row, and one vacancy row. Order is
 * unit order (not severity — that sort happens in mergeAttention).
 */
export function deriveTasks(units: PropertyDetailUnit[]): DerivedTask[] {
  const active = units.filter((unit) => !unit.archivedAt);
  const tasks: DerivedTask[] = [];

  for (const unit of active) {
    const lease = unit.currentLease;
    // A tenant-first subject: "D. Park · Unit A", or just the unit label.
    const primary = lease?.tenants[0]?.fullName;
    const subject = primary ? `${primary} · ${unit.label}` : unit.label;
    const leaseId = lease?.id ?? null;
    const tenantIds = lease?.tenants.map((tenant) => tenant.id) ?? [];

    // --- Rent rows (rent is null when no charge touches this month — e.g. a
    //     lease starting next month — so a null is calm, not missing data) ---
    const rent = unit.rent;
    if (lease && rent) {
      const trackerLink: TaskAffordance = { type: 'tracker-link', period: rent.period };
      const received = `${formatUsd(rent.paidCents)} of ${formatUsd(rent.amountCents)} received`;
      if (rent.status === 'late') {
        const lateBit = rent.daysLate != null ? `${daysLabel(rent.daysLate)} late` : 'late';
        tasks.push({
          kind: 'rent',
          unitId: unit.id,
          leaseId,
          tenantIds,
          severity: 0,
          tone: 'danger',
          badge: rent.daysLate != null ? `${daysLabel(rent.daysLate)} late` : 'Late',
          sentence: `${subject} — ${lateBit}${rent.paidCents > 0 ? ` · ${received}` : ''}`,
          affordance: trackerLink,
        });
      } else if (rent.status === 'failed') {
        tasks.push({
          kind: 'rent',
          unitId: unit.id,
          leaseId,
          tenantIds,
          severity: 0,
          tone: 'danger',
          badge: 'Failed',
          sentence: `${subject} — rent payment failed this month`,
          affordance: trackerLink,
        });
      } else if (rent.status === 'partial') {
        tasks.push({
          kind: 'rent',
          unitId: unit.id,
          leaseId,
          tenantIds,
          severity: 1,
          tone: 'warning',
          badge: `${formatUsd(rent.paidCents)} of ${formatUsd(rent.amountCents)} received`,
          sentence: `${subject} — ${received}`,
          affordance: trackerLink,
        });
      } else if (rent.status === 'processing') {
        tasks.push({
          kind: 'rent',
          unitId: unit.id,
          leaseId,
          tenantIds,
          severity: 2,
          tone: 'neutral',
          badge: 'Processing',
          sentence: `${subject} — rent payment is processing`,
          affordance: trackerLink,
        });
      }
    }

    // --- Lease-expiry rows. A lease whose endDate has passed stays 'active'
    //     (nothing auto-ends it) — that's a de facto month-to-month lapse and
    //     the moment renewal most needs attention, so it ranks above the
    //     merely-expiring rows. ---------------------------------------------
    if (lease) {
      const days = daysUntil(lease.endDate);
      if (days <= RENEW_SOON_DAYS) {
        if (unit.pendingLease) {
          tasks.push({
            kind: 'renewal',
            unitId: unit.id,
            leaseId,
            tenantIds,
            severity: 2,
            tone: 'neutral',
            badge: 'Awaiting signature',
            sentence: primary
              ? `${primary}'s renewal on ${unit.label} is awaiting signature`
              : `The renewal on ${unit.label} is awaiting signature`,
            affordance: null,
          });
        } else {
          const whose = primary ? `${primary}'s lease` : 'The lease';
          const lapsed = days < 0;
          tasks.push({
            kind: 'renewal',
            unitId: unit.id,
            leaseId,
            tenantIds,
            severity: lapsed ? 0 : 1,
            tone: lapsed ? 'danger' : 'warning',
            badge: lapsed ? 'Month-to-month' : 'Lease ending',
            sentence: lapsed
              ? `${whose} on ${unit.label} ended ${daysLabel(-days)} ago — now running month-to-month`
              : days === 0
                ? `${whose} on ${unit.label} ends today`
                : `${whose} on ${unit.label} ends in ${daysLabel(days)}`,
            affordance: { type: 'draft-renewal', lease },
          });
        }
      }
    }

    // --- Vacancy rows -------------------------------------------------------
    if (!lease && unit.status === 'vacant') {
      tasks.push({
        kind: 'vacancy',
        unitId: unit.id,
        leaseId: null,
        tenantIds: [],
        severity: 1,
        tone: 'warning',
        badge: 'Vacant',
        sentence: `${unit.label} is vacant`,
        affordance: { type: 'create-lease', unit },
      });
    }
  }

  return tasks;
}

/**
 * Definite match: insight.leaseId is non-null and equals the task's leaseId
 * (kind-respecting: late_rent↔rent, renewal_window↔renewal). This is the
 * precedence signal in mergeAttention's first pass — it never falls back to
 * tenantId, so an insight naming a specific lease always reaches that
 * lease's unit even when a tenant shares another active lease elsewhere on
 * the property.
 */
function matchesByLeaseId(insight: Insight, task: DerivedTask): boolean {
  if (insight.type === 'late_rent' && task.kind === 'rent') {
    return insight.leaseId !== null && insight.leaseId === task.leaseId;
  }
  if (insight.type === 'renewal_window' && task.kind === 'renewal') {
    return insight.leaseId !== null && insight.leaseId === task.leaseId;
  }
  return false;
}

/**
 * Fallback match, used only when no leaseId match claimed the insight
 * anywhere: tenantId equality for late_rent (a renewal switchover can leave
 * the month's charge on the outgoing lease while currentLease is already
 * the new one), or a null leaseId for renewal_window (defensive — this
 * insight type currently never carries a propertyId, so it can't actually
 * reach this page; null just means "don't rule it out" rather than a real
 * match signal).
 */
function matchesByFallback(insight: Insight, task: DerivedTask): boolean {
  if (insight.type === 'late_rent' && task.kind === 'rent') {
    return insight.tenantId !== null && task.tenantIds.includes(insight.tenantId);
  }
  if (insight.type === 'renewal_window' && task.kind === 'renewal') {
    return insight.leaseId == null;
  }
  return false;
}

/**
 * Whether an insight is "about" the given derived task. Never parses
 * insight.dedupeKey (name-slug based, not a stable id) — matching is by
 * leaseId/tenantId only. Combines both precedence tiers (see
 * matchesByLeaseId/matchesByFallback); mergeAttention applies them in two
 * separate passes so a leaseId match always wins over a tenantId fallback.
 */
export function insightMatchesTask(insight: Insight, task: DerivedTask): boolean {
  return matchesByLeaseId(insight, task) || matchesByFallback(insight, task);
}

/**
 * Merges derived tasks with backend insights into one deduplicated,
 * severity-sorted list: a matching late_rent insight enriches (not
 * duplicates) its rent task row; a matching renewal_window insight is
 * suppressed entirely (the task row already says it); everything else
 * becomes its own insight-only row.
 *
 * Matching runs in two passes so a definite leaseId match always takes
 * precedence over the tenantId fallback: e.g. one tenant on two active late
 * leases in the same property (Unit A lease l1, Unit B lease l2) with a
 * single late_rent insight carrying leaseId l2 must attach to Unit B, not
 * fall through to Unit A via the shared tenantId.
 */
export function mergeAttention(tasks: DerivedTask[], insights: Insight[]): AttentionRow[] {
  const usedInsightIds = new Set<string>();
  const matchedByTask = new Map<DerivedTask, Insight>();

  // Pass 1: definite leaseId matches claim first, in unit order.
  for (const task of tasks) {
    const matched = insights.find(
      (insight) => !usedInsightIds.has(insight.id) && matchesByLeaseId(insight, task),
    );
    if (matched) {
      usedInsightIds.add(matched.id);
      matchedByTask.set(task, matched);
    }
  }

  // Pass 2: tenantId fallback (late_rent) / null-leaseId suppression
  // (renewal_window) — only for insights pass 1 left unclaimed, still
  // first-match in unit order, and never revisiting a task pass 1 already
  // matched.
  for (const task of tasks) {
    if (matchedByTask.has(task)) continue;
    const matched = insights.find(
      (insight) => !usedInsightIds.has(insight.id) && matchesByFallback(insight, task),
    );
    if (matched) {
      usedInsightIds.add(matched.id);
      matchedByTask.set(task, matched);
    }
  }

  const rows: AttentionRow[] = [];
  for (const task of tasks) {
    const matchedInsight = matchedByTask.get(task);

    const row: AttentionRow = {
      key: `task:${task.kind}:${task.unitId}`,
      severity: task.severity,
      tone: task.tone,
      badge: task.badge,
      sentence: task.sentence,
      task,
    };
    // A matched renewal_window insight is suppressed entirely (see the
    // function doc) — attached nowhere, so it never lands on row.insight.
    if (matchedInsight && task.kind !== 'renewal') row.insight = matchedInsight;
    rows.push(row);
  }

  for (const insight of insights) {
    if (usedInsightIds.has(insight.id)) continue;
    rows.push({
      key: `insight:${insight.id}`,
      severity: INSIGHT_SEVERITY_RANK[insight.severity],
      tone: severityBadge[insight.severity].tone,
      badge: severityBadge[insight.severity].label,
      sentence: insight.title,
      detail: insight.body,
      insight,
    });
  }

  rows.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity - b.severity;
    const aIsTask = Boolean(a.task);
    const bIsTask = Boolean(b.task);
    if (aIsTask !== bIsTask) return aIsTask ? -1 : 1;
    if (aIsTask) return 0; // both task rows: stable sort keeps unit order
    // both insight-only rows: newest first
    return (b.insight?.createdAt ?? '').localeCompare(a.insight?.createdAt ?? '');
  });

  return rows;
}

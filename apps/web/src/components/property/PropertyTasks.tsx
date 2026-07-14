// "Needs attention" triage for a property — rows derived from the detail
// payload (rent trouble, leases ending soon, vacancies), severity first. Plain
// Card, not AiSurface: this is arithmetic over the ledger, not model output.
// Each row carries exactly one trailing affordance — a Link when it navigates,
// a Button when it acts in place.
import type { ReactNode } from 'react';
import { RENEW_SOON_DAYS, formatUsd } from '@hearth/shared';
import type { LeaseWithTenants, PropertyDetailUnit } from '@hearth/shared';
import { Link } from 'react-router-dom';
import { daysUntil } from '../../lib/format';
import { Button, buttonClasses } from '../ui/Button';
import { Card } from '../ui/Card';
import { StatusBadge, type BadgeTone } from '../ui/StatusBadge';

export interface PropertyTasksProps {
  /** Property display name, for the all-clear line. */
  title: string;
  units: PropertyDetailUnit[];
  /** Gates the in-place write affordances (Draft renewal / Create lease). */
  canTenants: boolean;
  draftBusy: boolean;
  onDraftRenewal: (lease: LeaseWithTenants) => void;
  onCreateLease: (unit: PropertyDetailUnit) => void;
}

interface TaskRow {
  key: string;
  severity: number; // 0 danger · 1 warning · 2 neutral
  tone: BadgeTone;
  badge: string;
  sentence: string;
  affordance?: ReactNode;
}

const daysLabel = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

export function PropertyTasks({
  title,
  units,
  canTenants,
  draftBusy,
  onDraftRenewal,
  onCreateLease,
}: PropertyTasksProps) {
  const active = units.filter((unit) => !unit.archivedAt);

  const rows: TaskRow[] = [];

  for (const unit of active) {
    const lease = unit.currentLease;
    // A tenant-first subject: "D. Park · Unit A", or just the unit label.
    const primary = lease?.tenants[0]?.fullName;
    const subject = primary ? `${primary} · ${unit.label}` : unit.label;

    // --- Rent rows (rent is null when no charge touches this month — e.g. a
    //     lease starting next month — so a null is calm, not missing data) ---
    const rent = unit.rent;
    if (lease && rent) {
      const trackerLink = (
        <Link to={`/rent?period=${rent.period}`} className={buttonClasses('ghost', 'sm')}>
          Open rent tracker →
        </Link>
      );
      const received = `${formatUsd(rent.paidCents)} of ${formatUsd(rent.amountCents)} received`;
      if (rent.status === 'late') {
        const lateBit = rent.daysLate != null ? `${daysLabel(rent.daysLate)} late` : 'late';
        rows.push({
          key: `rent-${unit.id}`,
          severity: 0,
          tone: 'danger',
          badge: rent.daysLate != null ? `${daysLabel(rent.daysLate)} late` : 'Late',
          sentence: `${subject} — ${lateBit}${rent.paidCents > 0 ? ` · ${received}` : ''}`,
          affordance: trackerLink,
        });
      } else if (rent.status === 'failed') {
        rows.push({
          key: `rent-${unit.id}`,
          severity: 0,
          tone: 'danger',
          badge: 'Failed',
          sentence: `${subject} — rent payment failed this month`,
          affordance: trackerLink,
        });
      } else if (rent.status === 'partial') {
        rows.push({
          key: `rent-${unit.id}`,
          severity: 1,
          tone: 'warning',
          badge: `${formatUsd(rent.paidCents)} of ${formatUsd(rent.amountCents)} received`,
          sentence: `${subject} — ${received}`,
          affordance: trackerLink,
        });
      } else if (rent.status === 'processing') {
        rows.push({
          key: `rent-${unit.id}`,
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
          rows.push({
            key: `renewal-${unit.id}`,
            severity: 2,
            tone: 'neutral',
            badge: 'Awaiting signature',
            sentence: primary
              ? `${primary}'s renewal on ${unit.label} is awaiting signature`
              : `The renewal on ${unit.label} is awaiting signature`,
          });
        } else {
          const whose = primary ? `${primary}'s lease` : 'The lease';
          const lapsed = days < 0;
          rows.push({
            key: `renewal-${unit.id}`,
            severity: lapsed ? 0 : 1,
            tone: lapsed ? 'danger' : 'warning',
            badge: lapsed ? 'Month-to-month' : 'Lease ending',
            sentence: lapsed
              ? `${whose} on ${unit.label} ended ${daysLabel(-days)} ago — now running month-to-month`
              : days === 0
                ? `${whose} on ${unit.label} ends today`
                : `${whose} on ${unit.label} ends in ${daysLabel(days)}`,
            affordance: canTenants ? (
              <Button
                variant="secondary"
                size="sm"
                busy={draftBusy}
                onClick={() => onDraftRenewal(lease)}
              >
                Draft renewal
              </Button>
            ) : undefined,
          });
        }
      }
    }

    // --- Vacancy rows -------------------------------------------------------
    if (!lease && unit.status === 'vacant') {
      rows.push({
        key: `vacant-${unit.id}`,
        severity: 1,
        tone: 'warning',
        badge: 'Vacant',
        sentence: `${unit.label} is vacant`,
        affordance: canTenants ? (
          <Button variant="secondary" size="sm" onClick={() => onCreateLease(unit)}>
            Create lease
          </Button>
        ) : undefined,
      });
    }
  }

  rows.sort((a, b) => a.severity - b.severity);

  return (
    <Card>
      <h2 className="text-base font-semibold text-ink">Needs attention</h2>
      {rows.length > 0 ? (
        <ul className="mt-3 flex flex-col divide-y divide-border">
          {rows.map((row) => (
            <li
              key={row.key}
              className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <StatusBadge tone={row.tone}>{row.badge}</StatusBadge>
                <span>{row.sentence}</span>
              </div>
              {row.affordance}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
          <StatusBadge tone="positive">All clear</StatusBadge>
          <span>
            All clear at {title} — rent on track, no leases ending in the next {RENEW_SOON_DAYS}{' '}
            days.
          </span>
        </p>
      )}
    </Card>
  );
}

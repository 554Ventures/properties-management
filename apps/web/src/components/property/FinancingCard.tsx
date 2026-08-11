// "Financing & value" card (PLAN-REAL-EQUITY Phase 1, property.ts:106-119):
// each non-archived mortgage with its derived balance, the latest owner-
// provided valuation, and the server-derived equity figure — equityCents is
// never recomputed here. Self-contained like DocumentsCard: owns its own
// modal state, embedded directly in PropertyDetail's Financials region.
// User-entered data, not AI-authored — never wrapped in AiSurface.
import { useState } from 'react';
import { formatUsd, formatUsdWhole } from '@hearth/shared';
import type { Mortgage, PropertyEquity, PropertyValuation, ValuationSource } from '@hearth/shared';
import { useArchiveMortgage, useRestoreMortgage } from '../../api/queries';
import { cx } from '../../lib/cx';
import { formatDate, formatInterestRate } from '../../lib/format';
import { MortgageCheckpointModal } from '../forms/MortgageCheckpointModal';
import { MortgageFormModal } from '../forms/MortgageFormModal';
import { ValuationFormModal } from '../forms/ValuationFormModal';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { RowActions, type RowAction } from '../ui/RowActions';
import { StatusBadge } from '../ui/StatusBadge';
import { Table, Td, Th, Tr } from '../ui/Table';
import { useToast } from '../ui/Toast';
import { IconArchive, IconDollar, IconPencil, IconPlus } from '../ui/icons';
import { ValuationHistoryModal } from './ValuationHistoryModal';

const VALUATION_SOURCE_LABEL: Record<ValuationSource, string> = {
  owner_estimate: 'Owner estimate',
  appraisal: 'Appraisal',
  tax_assessment: 'Tax assessment',
  other: 'Other',
};

type FinancingModal =
  | { kind: 'add-mortgage' }
  | { kind: 'update-balance'; mortgage: Mortgage }
  | { kind: 'record-value' }
  | { kind: 'valuation-history' }
  | null;

export interface FinancingCardProps {
  propertyId: string;
  title: string;
  mortgages: Mortgage[];
  latestValuation: PropertyValuation | null;
  equity: PropertyEquity | null;
  canProperties: boolean;
}

export function FinancingCard({
  propertyId,
  title,
  mortgages,
  latestValuation,
  equity,
  canProperties,
}: FinancingCardProps) {
  const { toast } = useToast();
  const archiveMortgage = useArchiveMortgage();
  const restoreMortgage = useRestoreMortgage();
  const [modal, setModal] = useState<FinancingModal>(null);
  const [showArchived, setShowArchived] = useState(false);

  const activeMortgages = mortgages.filter((m) => !m.archivedAt);
  const archivedMortgages = mortgages.filter((m) => m.archivedAt);
  const visibleMortgages = showArchived ? mortgages : activeMortgages;

  const doArchive = (mortgage: Mortgage) => {
    archiveMortgage.mutate(
      { id: mortgage.id, propertyId },
      {
        onSuccess: () => toast(`${mortgage.lender} mortgage archived.`, 'positive'),
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not archive the mortgage.', 'danger'),
      },
    );
  };

  const doRestore = (mortgage: Mortgage) => {
    restoreMortgage.mutate(
      { id: mortgage.id, propertyId },
      {
        onSuccess: () => toast(`${mortgage.lender} mortgage restored.`, 'positive'),
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not restore the mortgage.', 'danger'),
      },
    );
  };

  // assetBasis tells us which figure fed assetValueCents — label it honestly
  // rather than let "equity" read as market equity (PLAN-REAL-EQUITY §5).
  const assetLabel =
    equity?.assetBasis === 'valuation' ? 'Asset value (owner-provided)' : 'Asset value (at cost)';

  return (
    <section aria-label="Financing & value" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">Financing &amp; value</h2>
        {canProperties && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setModal({ kind: 'record-value' })}>
              <IconPlus size={14} />
              Record value
            </Button>
            <Button size="sm" onClick={() => setModal({ kind: 'add-mortgage' })}>
              <IconPlus size={14} />
              Add mortgage
            </Button>
          </div>
        )}
      </div>

      <Card className="flex flex-col gap-5">
        {equity ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FinancingStat label={assetLabel} value={formatUsdWhole(equity.assetValueCents)} />
            <FinancingStat label="Mortgage balance" value={formatUsdWhole(equity.liabilityCents)} />
            <FinancingStat label="Equity" value={formatUsdWhole(equity.equityCents)} emphasize />
          </div>
        ) : (
          <EmptyState
            icon={<IconDollar size={28} />}
            title="Add a value to see equity"
            body="Record a valuation, or set an acquisition cost on the property, to calculate equity for this property."
            action={
              canProperties ? (
                <Button size="sm" onClick={() => setModal({ kind: 'record-value' })}>
                  Record value
                </Button>
              ) : undefined
            }
          />
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-sm">
          {latestValuation ? (
            <p className="text-ink">
              Latest value <strong>{formatUsd(latestValuation.valueCents)}</strong> as of{' '}
              {formatDate(latestValuation.asOfDate)} ·{' '}
              {VALUATION_SOURCE_LABEL[latestValuation.source]}, owner-provided
            </p>
          ) : (
            <p className="text-ink-muted">No valuation on file.</p>
          )}
          <button
            type="button"
            className="text-xs font-medium text-ink underline underline-offset-2 transition-colors duration-fast hover:text-brand"
            onClick={() => setModal({ kind: 'valuation-history' })}
          >
            Valuation history
          </button>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">Mortgages</h3>
            {archivedMortgages.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={showArchived}
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived ? 'Hide archived' : `Show archived (${archivedMortgages.length})`}
              </Button>
            )}
          </div>
          {mortgages.length === 0 ? (
            <p className="text-sm text-ink-muted">No mortgages on file.</p>
          ) : visibleMortgages.length === 0 ? (
            <p className="text-sm text-ink-muted">
              All mortgages here are archived — use “Show archived” above to see them.
            </p>
          ) : (
            <Table caption={`${title} — mortgages`}>
              <thead>
                <tr>
                  <Th>Lender</Th>
                  <Th align="right">Balance</Th>
                  <Th>Rate</Th>
                  <Th align="right" stickyRight>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {visibleMortgages.map((mortgage) => {
                  const actions: RowAction[] = canProperties
                    ? [
                        {
                          label: 'Update balance',
                          icon: <IconPencil size={14} />,
                          onClick: () => setModal({ kind: 'update-balance', mortgage }),
                        },
                        {
                          label: 'Archive',
                          icon: <IconArchive size={14} />,
                          onClick: () => doArchive(mortgage),
                        },
                      ]
                    : [];
                  return (
                    <Tr key={mortgage.id}>
                      <Td className="font-medium">
                        {mortgage.lender}
                        {mortgage.archivedAt && (
                          <div className="mt-1">
                            <StatusBadge tone="neutral">Archived</StatusBadge>
                          </div>
                        )}
                      </Td>
                      <Td align="right" className="tabular-nums">
                        {formatUsd(mortgage.currentBalanceCents)}
                        <p className="mt-0.5 text-xs text-ink-muted">
                          as of {formatDate(mortgage.balanceAsOfDate)}
                        </p>
                      </Td>
                      <Td>
                        {mortgage.interestRateMilliPct != null ? (
                          formatInterestRate(mortgage.interestRateMilliPct)
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
                      </Td>
                      <Td align="right" stickyRight>
                        {mortgage.archivedAt ? (
                          canProperties ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              busy={restoreMortgage.isPending}
                              onClick={() => doRestore(mortgage)}
                            >
                              Restore
                            </Button>
                          ) : null
                        ) : (
                          <RowActions context={`${mortgage.lender} mortgage`} actions={actions} />
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </div>
      </Card>

      {modal?.kind === 'add-mortgage' && (
        <MortgageFormModal open propertyId={propertyId} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'update-balance' && (
        <MortgageCheckpointModal
          open
          propertyId={propertyId}
          mortgage={modal.mortgage}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'record-value' && (
        <ValuationFormModal open propertyId={propertyId} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'valuation-history' && (
        <ValuationHistoryModal
          propertyId={propertyId}
          title={title}
          canProperties={canProperties}
          onClose={() => setModal(null)}
        />
      )}
    </section>
  );
}

function FinancingStat({
  label,
  value,
  emphasize = false,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
      <p
        className={cx(
          'font-semibold tabular-nums text-ink',
          emphasize ? 'text-2xl' : 'text-xl',
        )}
      >
        {value}
      </p>
    </div>
  );
}

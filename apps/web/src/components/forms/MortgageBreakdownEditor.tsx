// Mortgage-payment breakdown editor (PLAN-REAL-EQUITY §3, Phase 2 item 8,
// decision D4 — "Amortization assist: DECIDED no"). A mortgage debit is one
// bank row that is really principal (repays the loan, not an expense) +
// interest/escrow (a real expense). The owner explicitly rejected computing
// that split from `interestRateMilliPct`/the balance: extra principal
// payments, refinances, recasts, ARM adjustments, and escrow re-assessments
// all silently invalidate a calculation, and because the split must
// reconcile exactly, an error hides in whichever component absorbs it. This
// editor therefore NEVER computes principal or the remainder split — the
// user types every figure off the bank debit and their statement. Shared by
// the review-queue confirm card (MoneyReview.tsx, offered when a detected
// row's `mortgageId` is set) and TransactionEditModal (correcting a payment
// after confirming) — one component, one place the split math lives.
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUsd } from '@hearth/shared';
import type { Category } from '@hearth/shared';
import { useTransactions } from '../../api/queries';
import { cx } from '../../lib/cx';
import { Button } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';
import { Select } from '../ui/Select';
import { IconPlus, IconTrash } from '../ui/icons';

// ── split-row machinery (also used, unmodified, by TransactionEditModal's own
// ordinary multi-category split editor — one representation of "a total
// divided across categories that must sum exactly", not a second one). ──────
export interface SplitRow {
  categoryId: string;
  amount: string; // dollars, string input value
}

export const emptySplitRows = (): SplitRow[] => [
  { categoryId: '', amount: '' },
  { categoryId: '', amount: '' },
];

export function parseCents(value: string): number {
  const n = Number(value);
  return value.trim() !== '' && !Number.isNaN(n) ? Math.round(n * 100) : 0;
}

// Single switch for whether the editor recalls last month's own entry. The
// owner has not finalized prefill-vs-blank (PLAN-REAL-EQUITY §7 open items) —
// flip this to `false` to always start blank without touching anything else.
export const PREFILL_FROM_LAST_MONTH = true;

export const PREFILL_LABEL = 'Same as last month — update from your statement if it changed.';

// How far back to look for "last month's" payment on the same mortgage.
// TransactionListQuery has no mortgageId filter (Phase 2's contract doesn't
// add one), so this fetches the account's recent confirmed expenses
// (optionally scoped to the mortgage's property) and matches mortgageId
// client-side — the most recent match wins since the list is date-desc.
const PREFILL_LOOKBACK_LIMIT = 50;

export interface MortgageBreakdownValue {
  principal: string; // dollars string, mirrors the `amount` field convention elsewhere
  // The remainder's category when it's ONE line (the common case — a loan
  // with no escrow, or interest and escrow lumped under one category). The
  // owner rejected auto-computing the split (D4): a single category is a
  // legitimate, complete answer on its own, not a placeholder for a second
  // one the user has to invent.
  remainderCategoryId: string;
  // Whether the remainder is broken across more than one category — an
  // explicit opt-in ("Split across categories"), never the default.
  splitMode: boolean;
  splitRows: SplitRow[];
}

export function emptyMortgageBreakdown(): MortgageBreakdownValue {
  return { principal: '', remainderCategoryId: '', splitMode: false, splitRows: emptySplitRows() };
}

/**
 * Whether the breakdown is complete enough to save: a principal within
 * `[0, amountCents]`, and — unless principal covers the whole payment —
 * either one chosen remainder category, or (in split mode) at least two
 * categories whose amounts sum exactly to the remainder. Gates the
 * Confirm/Save button; `remainingToAllocateCents` below drives the live
 * status text shown alongside it.
 */
export function isMortgageBreakdownValid(
  amountCents: number,
  value: MortgageBreakdownValue,
): boolean {
  if (value.principal.trim() === '') return false;
  const principalCents = parseCents(value.principal);
  if (principalCents < 0 || principalCents > amountCents) return false;
  const remainderCents = amountCents - principalCents;
  if (remainderCents === 0) return true; // principal-only payment — nothing to categorize
  if (!value.splitMode) return Boolean(value.remainderCategoryId);
  const rows = value.splitRows;
  if (rows.length < 2) return false;
  const complete = rows.every(
    (r) => r.categoryId && r.amount.trim() !== '' && parseCents(r.amount) > 0,
  );
  if (!complete) return false;
  const allocated = rows.reduce((sum, r) => sum + parseCents(r.amount), 0);
  return allocated === remainderCents;
}

/** Live "remaining to allocate" figure for display — a blank principal shows
 *  the full amount as unaccounted for; an out-of-range principal shows $0
 *  remaining here (its own error message covers that case instead). Only
 *  meaningful in split mode; a single remainder category is either chosen
 *  (nothing remaining) or not (the whole remainder still does). */
export function remainingToAllocateCents(
  amountCents: number,
  value: MortgageBreakdownValue,
): number {
  if (value.principal.trim() === '') return amountCents;
  const principalCents = parseCents(value.principal);
  const remainderCents = amountCents - principalCents;
  if (remainderCents <= 0) return 0;
  if (!value.splitMode) return value.remainderCategoryId ? 0 : remainderCents;
  const allocated = value.splitRows.reduce((sum, r) => sum + parseCents(r.amount), 0);
  return remainderCents - allocated;
}

/** The API payload slice: `principalCents` plus either a single `categoryId`
 *  or `splits` (never both) covering the remainder — both omitted for a
 *  principal-only payment. Call only once `isMortgageBreakdownValid` is
 *  true. `splits` always carries 2+ entries here since split mode requires
 *  it — the shared schema's `.min(2)` rejects a one-line "split". */
export function mortgageBreakdownPayload(
  amountCents: number,
  value: MortgageBreakdownValue,
): {
  principalCents: number;
  categoryId?: string;
  splits?: { categoryId: string; amountCents: number }[];
} {
  const principalCents = parseCents(value.principal);
  const remainderCents = amountCents - principalCents;
  if (remainderCents === 0) return { principalCents };
  if (value.splitMode) {
    return {
      principalCents,
      splits: value.splitRows.map((r) => ({
        categoryId: r.categoryId,
        amountCents: parseCents(r.amount),
      })),
    };
  }
  return { principalCents, categoryId: value.remainderCategoryId };
}

/** id of the live remaining-to-allocate status text, for wiring a disabled
 *  Confirm/Save button's `aria-describedby` to "why". */
export function mortgageBreakdownStatusId(idPrefix: string): string {
  return `${idPrefix}-remaining-status`;
}

// Defect: there is deliberately NO "Escrow" category — escrow money pays
// property taxes and insurance, the actual Schedule E lines (Property Taxes
// → Line 16, Insurance → Line 9); an "Escrow" category would map to neither
// and silently drop those dollars off the tax form. The miss was that the UI
// never said so, leaving a user with an escrowed payment hunting for
// "Escrow" and finding nothing. This one-click affordance sets up the three
// rows a typical escrowed payment needs — categories only, amounts left
// blank for the user to type off their statement (D4: never computed here).
const ESCROW_PRESET_CATEGORY_NAMES = ['Mortgage Interest', 'Property Taxes', 'Insurance'];
export const ESCROW_PRESET_LABEL = 'Interest + escrow (taxes, insurance)';

export interface MortgageBreakdownEditorProps {
  idPrefix: string;
  amountCents: number; // read-only — comes from the bank, never edited here
  mortgageId: string;
  propertyId?: string | null;
  excludeTransactionId?: string; // don't prefill from the row being edited itself
  value: MortgageBreakdownValue;
  onChange: (value: MortgageBreakdownValue) => void;
  categoryOptions: Category[];
  // The mortgage's own escrow arrangement notes (Mortgage.escrowNote), when
  // the caller already has them loaded — never fetched here just for this.
  escrowNote?: string | null;
}

export function MortgageBreakdownEditor({
  idPrefix,
  amountCents,
  mortgageId,
  propertyId,
  excludeTransactionId,
  value,
  onChange,
  categoryOptions,
  escrowNote,
}: MortgageBreakdownEditorProps) {
  const principalCents = value.principal.trim() !== '' ? parseCents(value.principal) : null;
  const principalNegative = principalCents != null && principalCents < 0;
  const principalTooLarge = principalCents != null && principalCents > amountCents;
  const principalInvalid = principalNegative || principalTooLarge;
  const remainderCents =
    principalCents != null && !principalInvalid ? amountCents - principalCents : 0;
  const showRemainder = principalCents != null && !principalInvalid && remainderCents > 0;
  const allocatedCents = value.splitRows.reduce((sum, r) => sum + parseCents(r.amount), 0);
  const remainingCents = remainingToAllocateCents(amountCents, value);
  const statusId = mortgageBreakdownStatusId(idPrefix);

  // Last month's own entry on this mortgage — recalled verbatim, never
  // recomputed. Only fetched while the prefill switch is on; only ever fills
  // a still-blank Principal field (never overwrites real data already on the
  // row, or anything the user has already typed).
  const lastPayments = useTransactions(
    {
      type: 'expense',
      status: 'confirmed',
      propertyId: propertyId || undefined,
      sort: 'date',
      dir: 'desc',
      limit: PREFILL_LOOKBACK_LIMIT,
    },
    PREFILL_FROM_LAST_MONTH,
  );
  const lastPayment = useMemo(() => {
    const items = lastPayments.data?.items ?? [];
    return (
      items.find(
        (t) =>
          t.mortgageId === mortgageId && t.principalCents != null && t.id !== excludeTransactionId,
      ) ?? null
    );
  }, [lastPayments.data, mortgageId, excludeTransactionId]);

  const appliedPrefillRef = useRef(false);
  const [prefillApplied, setPrefillApplied] = useState(false);
  useEffect(() => {
    if (!PREFILL_FROM_LAST_MONTH || appliedPrefillRef.current) return;
    if (value.principal.trim() !== '') return; // never overwrite real/typed data
    if (!lastPayment || lastPayment.principalCents == null) return;
    appliedPrefillRef.current = true;
    setPrefillApplied(true);
    const splits = lastPayment.splits ?? [];
    const hadSplitRemainder = splits.length > 0;
    onChange({
      principal: (lastPayment.principalCents / 100).toFixed(2),
      remainderCategoryId: hadSplitRemainder ? '' : (lastPayment.categoryId ?? ''),
      splitMode: hadSplitRemainder,
      splitRows: hadSplitRemainder
        ? splits.map((s) => ({
            categoryId: s.categoryId,
            amount: (s.amountCents / 100).toFixed(2),
          }))
        : emptySplitRows(),
    });
  }, [lastPayment, value.principal, onChange]);

  // Whether every split row is save-worthy (category + a positive amount) —
  // the same test `isMortgageBreakdownValid` applies, kept in sync here so
  // the live status text can name exactly which row is still blocking it
  // instead of just reporting the sum (defect: a sum that happens to
  // reconcile around one untouched row used to read as "$0.00 remaining",
  // i.e. complete, while Confirm/Save stayed disabled for no stated reason).
  const splitRowsComplete = value.splitRows.every(
    (r) => r.categoryId && r.amount.trim() !== '' && parseCents(r.amount) > 0,
  );

  // The live status text doubles as the disabled Confirm/Save button's
  // `aria-describedby` target (defect: it must always resolve, even in the
  // initial blank state — never dangle waiting for a principal to be typed).
  const statusText = (() => {
    if (value.principal.trim() === '') {
      return 'Enter the principal to see what still needs a category.';
    }
    if (principalNegative) return "Principal can't be negative — fix it above.";
    if (principalTooLarge) return "Principal can't be more than the total payment — fix it above.";
    if (remainderCents === 0) {
      return 'Principal covers the whole payment — nothing left to categorize.';
    }
    if (!value.splitMode) {
      return value.remainderCategoryId
        ? `${formatUsd(remainderCents)} will be categorized as the remainder category below.`
        : `Choose a category for the ${formatUsd(remainderCents)} remaining.`;
    }
    const allocatedText = `${formatUsd(allocatedCents)} of ${formatUsd(remainderCents)} allocated`;
    if (remainingCents === 0 && !splitRowsComplete) {
      // The sum happens to reconcile around a row that isn't actually
      // filled in (a category missing, an amount missing or zero) — saying
      // "$0.00 remaining" here would read as done while Confirm/Save stays
      // disabled for no stated reason (the defect). Name the row(s) still
      // blocking instead. An untouched trailing row reads as "still needs",
      // not as a scolding error.
      const issues = value.splitRows
        .map((r, i) => {
          if (r.categoryId && r.amount.trim() !== '' && parseCents(r.amount) > 0) return null;
          if (!r.categoryId && r.amount.trim() === '')
            return `row ${i + 1} still needs a category and amount`;
          if (!r.categoryId) return `row ${i + 1} needs a category`;
          return `row ${i + 1} needs an amount over $0`;
        })
        .filter((issue): issue is string => issue !== null);
      return `${allocatedText} · ${issues.join('; ')}`;
    }
    return `${allocatedText} · ${formatUsd(remainingCents)} remaining to allocate`;
  })();
  const statusIsProblem =
    principalInvalid ||
    (showRemainder && (remainingCents !== 0 || (value.splitMode && !splitRowsComplete)));

  const updateRow = (i: number, patch: Partial<SplitRow>) =>
    onChange({
      ...value,
      splitRows: value.splitRows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    });
  const addRow = () =>
    onChange({ ...value, splitRows: [...value.splitRows, { categoryId: '', amount: '' }] });
  const removeRow = (i: number) =>
    onChange({
      ...value,
      splitRows:
        value.splitRows.length > 2
          ? value.splitRows.filter((_, idx) => idx !== i)
          : value.splitRows,
    });
  // Defect 2's one-click affordance — sets up the three rows, categories
  // only; every amount stays blank for the user to type off their
  // statement. Falls back to '' for any name not present in this account's
  // category list (still pickable manually — never silently dropped).
  const applyEscrowPreset = () =>
    onChange({
      ...value,
      splitMode: true,
      splitRows: ESCROW_PRESET_CATEGORY_NAMES.map((name) => ({
        categoryId: categoryOptions.find((c) => c.name === name)?.id ?? '',
        amount: '',
      })),
    });

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-sunken p-3">
      <div>
        <p className="text-xs font-medium text-ink-muted">Total (from your bank)</p>
        <p className="text-base font-semibold tabular-nums text-ink">{formatUsd(amountCents)}</p>
      </div>
      <FormField
        label="Principal"
        htmlFor={`${idPrefix}-principal`}
        hint="Principal repays the loan, so it isn't an expense."
        error={
          principalNegative
            ? "Principal can't be negative."
            : principalTooLarge
              ? "Principal can't be more than the total payment."
              : undefined
        }
        required
      >
        <Input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={value.principal}
          onChange={(e) => onChange({ ...value, principal: e.target.value })}
        />
      </FormField>
      {prefillApplied && <p className="text-xs text-ink-muted">{PREFILL_LABEL}</p>}
      <p
        id={statusId}
        role="status"
        className={cx('text-sm', statusIsProblem ? 'font-medium text-danger' : 'text-ink-muted')}
      >
        {statusText}
      </p>
      {showRemainder && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3 text-sm text-ink-muted">
            <p>
              The rest of a mortgage payment is usually mortgage interest, plus any property taxes
              and insurance your lender collects in escrow. There&rsquo;s no separate
              &ldquo;Escrow&rdquo; category — record those as{' '}
              <span className="font-medium text-ink">Property Taxes</span> and{' '}
              <span className="font-medium text-ink">Insurance</span> so they land on the right tax
              lines.
            </p>
            {escrowNote && (
              <p>
                <span className="font-medium text-ink">This mortgage&rsquo;s escrow note: </span>
                {escrowNote}
              </p>
            )}
            <div>
              <Button type="button" variant="secondary" size="sm" onClick={applyEscrowPreset}>
                {ESCROW_PRESET_LABEL}
              </Button>
            </div>
          </div>
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-pressed={value.splitMode}
              onClick={() => onChange({ ...value, splitMode: !value.splitMode })}
            >
              {value.splitMode ? 'Remove split — use one category' : 'Split across categories'}
            </Button>
          </div>
          {!value.splitMode ? (
            <FormField label="Remainder category" htmlFor={`${idPrefix}-remainder-category`}>
              <Select
                value={value.remainderCategoryId}
                onChange={(e) => onChange({ ...value, remainderCategoryId: e.target.value })}
              >
                <option value="">Choose a category</option>
                {categoryOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : (
            <>
              {value.splitRows.map((row, i) => (
                <div
                  key={i}
                  className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_140px_auto] sm:items-end"
                >
                  <FormField
                    label={`Category ${i + 1}`}
                    htmlFor={`${idPrefix}-split-category-${i}`}
                  >
                    <Select
                      value={row.categoryId}
                      onChange={(e) => updateRow(i, { categoryId: e.target.value })}
                    >
                      <option value="">Choose a category</option>
                      {categoryOptions.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField
                    label={`Amount ${i + 1} (USD)`}
                    htmlFor={`${idPrefix}-split-amount-${i}`}
                  >
                    <Input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0.01"
                      value={row.amount}
                      onChange={(e) => updateRow(i, { amount: e.target.value })}
                    />
                  </FormField>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={value.splitRows.length <= 2}
                    onClick={() => removeRow(i)}
                  >
                    <IconTrash size={14} />
                    <span className="sr-only">Remove category {i + 1}</span>
                  </Button>
                </div>
              ))}
              <div>
                <Button variant="ghost" size="sm" onClick={addRow}>
                  <IconPlus size={14} />
                  Add category
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

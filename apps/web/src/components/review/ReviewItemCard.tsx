// One review-queue row. A triage row, not a form: the default is a ~72px line
// you can clear in one click (the primary button names the outcome — "Confirm
// as Supplies" — so accepting a suggestion never means reading a dropdown
// first), and the attribution form appears at full card width only for the rows
// that genuinely need it.
//
// A row auto-expands (and then has no collapse control, so the reason for a
// disabled Confirm can never be hidden) when it cannot be cleared in one click:
// no suggestion, confidence under the 0.7 gate, a possible duplicate, a
// detected mortgage payment, or a rent match that came out of an ambiguity.
// Everything the user has to *read* — those same conditions — renders as a
// full-bleed strip above the header row, where the copy fits.
import { useRef, useState } from 'react';
import type { Category, ReviewQueueItem, TransactionClassification } from '@hearth/shared';
import { ApiClientError } from '../../api/client';
import {
  useConfirmTransaction,
  useDismissTransaction,
  useLeaseDetail,
  useProperties,
  usePropertyDetail,
  useUpdateTransaction,
} from '../../api/queries';
import { cx } from '../../lib/cx';
import { formatDate, formatMonth } from '../../lib/format';
import { AiChip } from '../ai/AiChip';
import {
  emptyMortgageBreakdown,
  isMortgageBreakdownValid,
  mortgageBreakdownPayload,
  mortgageBreakdownStatusId,
  MortgageBreakdownEditor,
  type MortgageBreakdownValue,
} from '../forms/MortgageBreakdownEditor';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { FormField } from '../ui/FormField';
import { RowActions } from '../ui/RowActions';
import { Select } from '../ui/Select';
import { StatusBadge } from '../ui/StatusBadge';
import { useToast } from '../ui/Toast';
import { IconCheck, IconChevronDown } from '../ui/icons';
import { RentChargePickerModal } from './RentChargePickerModal';
import { ReviewRowAmount, ReviewRowIdentity } from './ReviewRowIdentity';
import { ReviewStrip } from './ReviewStrip';
import type { SettledOutcome } from './ReviewSettledCard';

/** Mirrors the API's BULK_CONFIRM_MIN_CONFIDENCE: below this a suggestion is
 *  never accepted in one click (and bulk confirm skips it server-side). */
export const LOW_CONFIDENCE_GATE = 0.7;

/** The API scores an uncontested exact-amount rent match at 0.9+ and a match
 *  it had to disambiguate (the descriptor's name broke a tie between several
 *  open charges) below that — so under 0.9, or a match that only completes a
 *  partially-paid charge, is a match worth opening the row for. */
const RENT_MATCH_UNCONTESTED_CONFIDENCE = 0.9;

interface LinkedRent {
  rentPaymentId: string;
  leaseId: string;
  tenantName: string;
  period: string;
  propertyLabel: string;
  unitLabel: string;
  // Audit provenance: an accepted AI chip audits ai_suggested_user_confirmed,
  // a hand-picked charge audits plain 'user'.
  source: 'suggestion' | 'manual';
  // Which co-tenant the deposit credits — set by the manual picker's own
  // "Paid by" field, or here in the card for an accepted AI suggestion.
  // Undefined lets the server infer it from the deposit's descriptor.
  tenantId?: string;
}

export interface ReviewItemCardProps {
  item: ReviewQueueItem;
  categoryOptions: Category[];
  /** Every write this card can make — confirm, dismiss, the attribution
   *  fields, the rent-link picker, the mortgage breakdown — is gated behind
   *  the account's `money` permission. Reads (the row itself, the AI
   *  suggestion chips, the warning strips) stay visible either way. */
  canMoney: boolean;
  /** Reports a successful write with the label to show and the height to hold
   *  (measured before the swap) so nothing moves under the pointer. */
  onSettled: (outcome: SettledOutcome, label: string, heightPx: number) => void;
}

export function ReviewItemCard({ item, categoryOptions, canMoney, onSettled }: ReviewItemCardProps) {
  const confirm = useConfirmTransaction();
  const dismiss = useDismissTransaction();
  const clearMortgageLink = useUpdateTransaction();
  const properties = useProperties();
  const { toast } = useToast();

  const [categoryId, setCategoryId] = useState('');
  // Attribution starts from whatever the row already carries (a receipt scan or
  // an import can arrive with a property) — the meta line names it, so the
  // select must not contradict it.
  const [propertyId, setPropertyId] = useState(item.propertyId ?? '');
  const [unitId, setUnitId] = useState(item.unitId ?? '');
  // '' = ordinary income/expense; transfer/owner money leaves P&L, refunds net.
  const [classification, setClassification] = useState<TransactionClassification | ''>(
    item.classification ?? '',
  );
  // The one armed rent link, however it got picked — the AI-suggested chip or
  // the manual picker — both explicit user actions (never auto-applied), and
  // mutually exclusive since this is a single piece of state.
  const [linkedRent, setLinkedRent] = useState<LinkedRent | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Mortgage payment breakdown (PLAN-REAL-EQUITY §3/D4): the backend detects
  // a mortgage payment by matching the vendor to a mortgage's lender and
  // stamps `mortgageId` — never an amount. A `mortgageId` here is the signal
  // to offer the breakdown; it's never inferred from anything else.
  const isMortgagePayment = item.type === 'expense' && Boolean(item.mortgageId);
  const [breakdown, setBreakdown] = useState<MortgageBreakdownValue>(emptyMortgageBreakdown);
  const breakdownComplete =
    !isMortgagePayment || isMortgageBreakdownValid(item.amountCents, breakdown);

  const [userExpanded, setUserExpanded] = useState(false);
  // Measured on the live card the instant before it settles.
  const cardRef = useRef<HTMLDivElement>(null);

  const propertyDetail = usePropertyDetail(propertyId || undefined);
  const units = propertyDetail.data?.units ?? [];
  const rentMatch = item.rentMatch;
  // The linked charge's lease tenants, for the "Paid by" field below — fetched
  // only once a charge is armed (suggestion or manual pick), never up front.
  const linkedLeaseDetail = useLeaseDetail(linkedRent?.leaseId);
  const linkedLeaseTenants = linkedLeaseDetail.data?.lease.tenants ?? [];
  // Surfaced only when already loaded (the units fetch above) — never a new
  // request just for this hint.
  const mortgageEscrowNote = propertyDetail.data?.mortgages.find(
    (m) => m.id === item.mortgageId,
  )?.escrowNote;
  const itemProperty = (properties.data ?? []).find((p) => p.id === item.propertyId);

  const detailsId = `review-details-${item.id}`;
  const mortgageStatusId = mortgageBreakdownStatusId(`review-mortgage-${item.id}`);

  const suggestionName = item.aiSuggestedCategoryId ? item.aiSuggestedCategoryName : null;
  const lowConfidence = item.aiConfidence != null && item.aiConfidence < LOW_CONFIDENCE_GATE;
  const ambiguousRentMatch =
    rentMatch != null &&
    (rentMatch.confidence < RENT_MATCH_UNCONTESTED_CONFIDENCE || rentMatch.paidCents > 0);
  // The auto-expand triggers: no user should have to open a row to find out
  // why its Confirm is dead, or to discover the only control that can unblock it.
  const mustExpand =
    !suggestionName ||
    lowConfidence ||
    Boolean(item.possibleDuplicate) ||
    isMortgagePayment ||
    ambiguousRentMatch;
  const expanded = mustExpand || userExpanded;

  // A template-drafted row and the bank's row for the same payment. Either side
  // can be the one on screen: this row carries `recurringTemplateId`, or the
  // match it found does (`source: 'recurring'`). Both are *pending*, so the
  // ordinary "a confirmed transaction matches" copy would be simply untrue —
  // and this is the pair most likely to be double-confirmed, since one of them
  // arrived without the user doing anything.
  const draftedPair =
    Boolean(item.possibleDuplicate) &&
    (Boolean(item.recurringTemplateId) || item.possibleDuplicate?.source === 'recurring');

  // The primary button names the outcome it will produce. A weak suggestion
  // deliberately does NOT name one — accepting it is a decision, not a reflex.
  const chosenCategoryName = categoryId
    ? (categoryOptions.find((c) => c.id === categoryId)?.name ?? null)
    : null;
  const outcomeName = linkedRent
    ? 'Rent'
    : isMortgagePayment
      ? null
      : (chosenCategoryName ?? (lowConfidence ? null : suggestionName));
  const confirmLabel = outcomeName ? `Confirm as ${outcomeName}` : 'Confirm';

  const confirmItem = () => {
    const payload = linkedRent
      ? {
          id: item.id,
          rentPaymentId: linkedRent.rentPaymentId,
          linkSource: linkedRent.source,
          tenantId: linkedRent.tenantId,
        }
      : isMortgagePayment
        ? {
            id: item.id,
            propertyId: propertyId || undefined,
            unitId: unitId || undefined,
            mortgageId: item.mortgageId as string,
            ...mortgageBreakdownPayload(item.amountCents, breakdown),
          }
        : {
            id: item.id,
            categoryId: categoryId || undefined,
            propertyId: propertyId || undefined,
            unitId: unitId || undefined,
            classification: classification || undefined,
          };
    // A rent-linked confirm always attributes to the lease's property; only
    // the plain-confirm path can leave the row unassigned.
    const staysUnassigned = !linkedRent && !propertyId;
    confirm.mutate(payload, {
      onSuccess: () => {
        // Measure before the swap — the settled card holds this height so no
        // row below it shifts under the pointer.
        const heightPx = cardRef.current?.getBoundingClientRect().height ?? 0;
        onSettled(
          'confirmed',
          linkedRent
            ? `Confirmed — ${linkedRent.tenantName}'s ${formatMonth(linkedRent.period)} rent paid`
            : outcomeName
              ? `Confirmed as ${outcomeName}`
              : 'Confirmed',
          heightPx,
        );
        toast(
          linkedRent
            ? `Confirmed and marked ${linkedRent.tenantName}'s ${formatMonth(linkedRent.period)} rent paid.`
            : `Confirmed “${item.description}”.`,
          'positive',
        );
        // Portfolio-level bank rows are common (e.g. a shared insurance
        // policy) and legitimate, but a nudge here is cheap insurance against
        // an unintentional skip — manual/receipt entries already went through
        // a form where "no property" was a deliberate choice.
        if (staysUnassigned && item.source === 'bank') {
          toast(
            "Confirmed without a property — assign one from the ledger's Edit action to keep per-property reports complete.",
            'neutral',
          );
        }
      },
      onError: (err) =>
        toast(
          err instanceof ApiClientError
            ? err.message
            : 'Could not confirm the transaction. Try again.',
          'danger',
        ),
    });
  };

  const dismissItem = () => {
    dismiss.mutate(item.id, {
      onSuccess: () => {
        const heightPx = cardRef.current?.getBoundingClientRect().height ?? 0;
        onSettled('dismissed', 'Dismissed', heightPx);
        toast(`Dismissed “${item.description}” — it won't count toward reports.`, 'positive');
      },
      onError: (err) =>
        toast(
          err instanceof ApiClientError
            ? err.message
            : 'Could not dismiss the transaction. Try again.',
          'danger',
        ),
    });
  };

  // Escape hatch for a wrong detection (vendor happened to match the lender —
  // a loan-servicer fee, say) — the row would otherwise be stuck demanding a
  // principal/interest breakdown it doesn't have. Clears the stamped link
  // server-side (`mortgageId`/`principalCents: null`); the queue refetch then
  // renders this card with the ordinary category/treatment picker.
  const notMortgagePayment = () => {
    clearMortgageLink.mutate(
      { id: item.id, mortgageId: null, principalCents: null },
      {
        onSuccess: () =>
          toast(
            "Won't be treated as a mortgage payment — categorize it normally below.",
            'positive',
          ),
        onError: (err) =>
          toast(
            err instanceof ApiClientError
              ? err.message
              : 'Could not clear the mortgage link. Try again.',
            'danger',
          ),
      },
    );
  };

  return (
    <div ref={cardRef}>
      <Card flush className="overflow-hidden">
        {/* ── strips: everything that must be read before deciding ─────── */}
        {rentMatch && (
          <ReviewStrip tone="ai">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              {/* Keep the chip to a label. AiChip is a pill sized for
                  "suggests: Repairs (84%)"; feeding it the property and unit
                  too made it a three-line pill on a phone. The location reads
                  better as prose beside it. */}
              <AiChip
                name={`${rentMatch.tenantName}'s ${formatMonth(rentMatch.period)} rent`}
                confidence={rentMatch.confidence}
                readOnly={!canMoney}
                applied={linkedRent?.rentPaymentId === rentMatch.rentPaymentId}
                onApply={() =>
                  setLinkedRent({
                    rentPaymentId: rentMatch.rentPaymentId,
                    leaseId: rentMatch.leaseId,
                    tenantName: rentMatch.tenantName,
                    period: rentMatch.period,
                    propertyLabel: rentMatch.propertyLabel,
                    unitLabel: rentMatch.unitLabel,
                    source: 'suggestion',
                  })
                }
                note={rentMatch.matchedName ? `deposit names ${rentMatch.matchedName}` : undefined}
              />
              <span className="text-ink-muted">
                {rentMatch.propertyLabel} · {rentMatch.unitLabel} — linking marks that charge paid
                instead of counting this deposit as new income.
              </span>
            </div>
          </ReviewStrip>
        )}
        {linkedRent && (
          <ReviewStrip tone="positive">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <p>
                Confirming marks <span className="font-medium">{linkedRent.tenantName}</span>’s{' '}
                {formatMonth(linkedRent.period)} rent paid and files this under{' '}
                <span className="font-medium">
                  {linkedRent.propertyLabel} · {linkedRent.unitLabel}
                </span>{' '}
                as Rent.
              </p>
              <Button variant="ghost" size="sm" onClick={() => setLinkedRent(null)}>
                Don't link to rent
              </Button>
            </div>
            {/* Only for a shared lease — a single-tenant charge has exactly
                one possible answer, so asking would be noise. Covers both
                paths into `linkedRent` (the suggestion chip and the manual
                picker) in one place, editable either way. */}
            {linkedLeaseTenants.length > 1 && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label
                  htmlFor={`review-rent-tenant-${item.id}`}
                  className="text-xs font-medium text-ink-muted"
                >
                  Paid by
                </label>
                <Select
                  id={`review-rent-tenant-${item.id}`}
                  value={linkedRent.tenantId ?? ''}
                  onChange={(e) =>
                    setLinkedRent({ ...linkedRent, tenantId: e.target.value || undefined })
                  }
                  className="w-auto py-1"
                >
                  <option value="">Not recorded</option>
                  {linkedLeaseTenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.fullName}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </ReviewStrip>
        )}
        {isMortgagePayment && !linkedRent && (
          <ReviewStrip tone="warning">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <p>
                <span className="font-semibold">Matches your mortgage</span> — enter the breakdown
                below before confirming.
              </p>
              {canMoney && (
                <Button
                  variant="ghost"
                  size="sm"
                  busy={clearMortgageLink.isPending}
                  onClick={notMortgagePayment}
                >
                  Not a mortgage payment
                </Button>
              )}
            </div>
          </ReviewStrip>
        )}
        {item.possibleDuplicate && (
          <ReviewStrip tone="danger">
            <p>
              <span className="font-semibold">Possible duplicate:</span>{' '}
              {item.possibleDuplicate.rentPeriod ? (
                <>
                  this looks like the deposit behind the rent you recorded manually for{' '}
                  {formatMonth(item.possibleDuplicate.rentPeriod)} (&ldquo;
                  {item.possibleDuplicate.description}&rdquo;,{' '}
                  {formatDate(item.possibleDuplicate.date)}
                  ). If it&rsquo;s the same money, Dismiss this one — or unlink the manual payment
                  on the Rent page first.
                </>
              ) : draftedPair ? (
                <>
                  {item.recurringTemplateId
                    ? 'this is the row your recurring template drafted, and your bank sent one that matches'
                    : 'your recurring template already drafted a row for this'}{' '}
                  (&ldquo;{item.possibleDuplicate.description}&rdquo;,{' '}
                  {formatDate(item.possibleDuplicate.date)}). They&rsquo;re the same payment —
                  confirm one and dismiss the other, or you&rsquo;ll count it twice.
                </>
              ) : (
                <>
                  a confirmed {item.possibleDuplicate.source} transaction matches this amount and
                  date (&ldquo;{item.possibleDuplicate.description}&rdquo;,{' '}
                  {formatDate(item.possibleDuplicate.date)}). If it&rsquo;s the same money, Dismiss
                  this one.
                </>
              )}
            </p>
          </ReviewStrip>
        )}
        {/* A weak suggestion needs no banner: the AI chip on the row already
            carries the confidence number, and the row auto-expands so the
            category select is right there. */}

        {/* ── the row itself ───────────────────────────────────────────── */}
        <div className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:gap-4">
          <ReviewRowIdentity
            item={item}
            propertyLabel={
              itemProperty ? (itemProperty.nickname ?? itemProperty.addressLine1) : null
            }
          />
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 md:flex-nowrap md:justify-end">
            {!linkedRent &&
              (suggestionName && item.aiSuggestedCategoryId ? (
                <AiChip
                  name={suggestionName}
                  confidence={item.aiConfidence ?? 0}
                  applied={categoryId === item.aiSuggestedCategoryId}
                  onApply={() => setCategoryId(item.aiSuggestedCategoryId as string)}
                  note={item.suggestionSource === 'learned' ? 'from your past choice' : undefined}
                  // The category select it fills isn't rendered without write
                  // access, so the chip informs rather than acts.
                  readOnly={!canMoney}
                />
              ) : (
                !rentMatch && <StatusBadge tone="neutral">No suggestion</StatusBadge>
              ))}
            {/* Provenance for a row the scheduler drafted from a
                RecurringTemplate (PLAN-REAL-EQUITY §2/Phase 2b) — text, not
                color alone, alongside the other state chips on this row. */}
            {item.recurringTemplateId && <StatusBadge tone="neutral">Auto-drafted</StatusBadge>}
            <ReviewRowAmount item={item} />
            {canMoney && (
              <div className="flex items-center gap-1">
                <Button
                  busy={confirm.isPending}
                  disabled={!breakdownComplete}
                  aria-describedby={
                    isMortgagePayment && !breakdownComplete ? mortgageStatusId : undefined
                  }
                  onClick={confirmItem}
                >
                  <IconCheck size={14} />
                  {confirmLabel}
                </Button>
                {/* Rows that must stay open have no toggle: collapsing one could
                    hide the only control that unblocks Confirm (and its
                    aria-describedby target with it). */}
                {!mustExpand && (
                  <Button
                    variant="secondary"
                    aria-expanded={expanded}
                    // Only reference the region while it exists: the details are
                    // unmounted when collapsed, and aria-controls pointing at a
                    // missing id is an invalid reference that assistive tech has
                    // to guess at. aria-expanded alone conveys the state.
                    aria-controls={expanded ? detailsId : undefined}
                    onClick={() => setUserExpanded((v) => !v)}
                  >
                    <IconChevronDown
                      size={16}
                      className={cx(
                        'transition-transform duration-fast',
                        expanded ? 'rotate-180' : undefined,
                      )}
                    />
                    <span className="sr-only">
                      {expanded ? 'Hide details' : 'Edit details'} — “{item.description}”
                    </span>
                  </Button>
                )}
                <RowActions
                  context={`“${item.description}”`}
                  actions={[{ label: 'Dismiss', onClick: dismissItem, busy: dismiss.isPending }]}
                />
              </div>
            )}
          </div>
        </div>

        {/* ── expanded region: full card width, a real grid ─────────────── */}
        {/* Every field here is a write (attribution, rent link, mortgage
            breakdown) — for a member without Money, opening it would show
            controls that lead nowhere, so the whole region is gated rather
            than rendering it inert. The strips above already carry the read
            content (mortgage match, duplicate, low confidence). */}
        {canMoney && expanded && (
          <div
            id={detailsId}
            className="flex flex-col gap-4 border-t border-border bg-surface-sunken px-4 py-4"
          >
            {linkedRent ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <p className="text-sm text-ink-muted">
                  Category, property and unit come from the lease while this deposit is linked.
                </p>
                <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
                  Link to rent…
                </Button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
                  {!isMortgagePayment && (
                    <FormField label="Category" htmlFor={`review-category-${item.id}`}>
                      <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                        <option value="">
                          {suggestionName
                            ? `Accept suggestion (${suggestionName})`
                            : 'Choose a category'}
                        </option>
                        {categoryOptions.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  )}
                  <FormField label="Property" htmlFor={`review-property-${item.id}`}>
                    <Select
                      value={propertyId}
                      onChange={(e) => {
                        setPropertyId(e.target.value);
                        setUnitId('');
                      }}
                    >
                      <option value="">Portfolio (no property)</option>
                      {(properties.data ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.nickname ?? p.addressLine1}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  {/* A disabled Unit select always states why, via the hint
                      FormField wires into its aria-describedby. */}
                  <FormField
                    label="Unit"
                    htmlFor={`review-unit-${item.id}`}
                    hint={
                      !propertyId
                        ? 'Pick a property first.'
                        : units.length === 0
                          ? 'This property has no units — it files against the whole property.'
                          : undefined
                    }
                  >
                    <Select
                      value={unitId}
                      onChange={(e) => setUnitId(e.target.value)}
                      disabled={!propertyId || units.length === 0}
                    >
                      <option value="">
                        {propertyId ? 'Whole property (no unit)' : 'Choose a property first'}
                      </option>
                      {units.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.label}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  {!isMortgagePayment && (
                    <FormField label="Treatment" htmlFor={`review-classification-${item.id}`}>
                      <Select
                        value={classification}
                        onChange={(e) =>
                          setClassification(e.target.value as TransactionClassification | '')
                        }
                      >
                        <option value="">
                          Ordinary {item.type === 'income' ? 'income' : 'expense'}
                        </option>
                        <option value="transfer">Transfer between my accounts (not counted)</option>
                        <option value="owner_contribution">Owner contribution (not counted)</option>
                        {item.type === 'income' && (
                          <option value="refund">Refund — nets against its expense category</option>
                        )}
                      </Select>
                    </FormField>
                  )}
                </div>
                {/* Manual path (not AI content — a plain button, not an AiChip):
                    every open charge, for the cases the heuristic missed
                    entirely. Stays reachable after a suggestion is accepted so a
                    manual pick can replace it (mutually exclusive — one
                    rentPaymentId). */}
                {item.type === 'income' && (
                  <div>
                    <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
                      Link to rent…
                    </Button>
                  </div>
                )}
              </>
            )}
            {/* The breakdown is a block in this region now — no longer a special
                case hanging below the card. */}
            {isMortgagePayment && !linkedRent && (
              <MortgageBreakdownEditor
                idPrefix={`review-mortgage-${item.id}`}
                amountCents={item.amountCents}
                mortgageId={item.mortgageId as string}
                propertyId={propertyId || item.propertyId}
                value={breakdown}
                onChange={setBreakdown}
                categoryOptions={categoryOptions}
                escrowNote={mortgageEscrowNote}
              />
            )}
          </div>
        )}
      </Card>
      {item.type === 'income' && (
        <RentChargePickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          amountCents={item.amountCents}
          onChoose={(option, tenantId) => {
            setLinkedRent({
              rentPaymentId: option.rentPaymentId,
              leaseId: option.leaseId,
              tenantName: option.tenantName,
              period: option.period,
              propertyLabel: option.propertyLabel,
              unitLabel: option.unitLabel,
              source: 'manual',
              tenantId,
            });
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

// The mortgage-payment breakdown editor (PLAN-REAL-EQUITY §3, Phase 2 item 8,
// decision D4): principal is always typed by the user, never computed from
// interestRateMilliPct or the balance. These tests exercise the shared
// component directly (a small controlled harness, same pattern as its own
// save-gating contract) — MoneyReview.test.tsx covers where it's offered
// (a detected row) and where it isn't (an ordinary expense).
import { useState } from 'react';
import type { Category, Transaction } from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyMortgageBreakdown,
  isMortgageBreakdownValid,
  mortgageBreakdownStatusId,
  MortgageBreakdownEditor,
  type MortgageBreakdownValue,
} from '../components/forms/MortgageBreakdownEditor';

function category(overrides: Partial<Category> & Pick<Category, 'id' | 'name' | 'type'>): Category {
  return { accountId: null, irsScheduleELine: null, isSystem: true, ...overrides };
}

const categoryOptions: Category[] = [
  category({ id: 'c-interest', name: 'Mortgage Interest', type: 'expense' }),
  category({ id: 'c-tax', name: 'Property Taxes', type: 'expense' }),
  category({ id: 'c-ins', name: 'Insurance', type: 'expense' }),
];

// $2,400 total; last month's own entry was $800 principal + $1,100 interest +
// $500 taxes ($1,600 remainder) — reused by the prefill test.
const AMOUNT_CENTS = 240000;

const lastMonthPayment: Transaction = {
  id: 'tx-last',
  accountId: 'acc1',
  propertyId: 'p1',
  unitId: null,
  categoryId: null,
  date: '2026-06-05T00:00:00.000Z',
  amountCents: AMOUNT_CENTS,
  type: 'expense',
  description: 'Mortgage payment',
  vendor: 'First National Bank',
  source: 'bank',
  status: 'confirmed',
  classification: null,
  aiSuggestedCategoryId: null,
  aiConfidence: null,
  receiptUrl: null,
  mortgageId: 'm1',
  principalCents: 80000,
  createdAt: '2026-06-05T00:00:00.000Z',
  updatedAt: '2026-06-05T00:00:00.000Z',
  splits: [
    { id: 's1', categoryId: 'c-interest', amountCents: 110000 },
    { id: 's2', categoryId: 'c-tax', amountCents: 50000 },
  ],
};

function stubTransactionsList(items: Transaction[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
      if (path === '/api/v1/transactions') {
        return Promise.resolve(
          new Response(JSON.stringify({ items, nextCursor: null, total: items.length }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'not_found', message: path } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
}

/** Controlled harness: a Save button disabled exactly per
 *  `isMortgageBreakdownValid`, mirroring how the two real call sites gate
 *  Confirm/Save. */
function Harness({
  amountCents = AMOUNT_CENTS,
  escrowNote,
}: {
  amountCents?: number;
  escrowNote?: string | null;
}) {
  const [value, setValue] = useState<MortgageBreakdownValue>(emptyMortgageBreakdown());
  const valid = isMortgageBreakdownValid(amountCents, value);
  return (
    <div>
      <MortgageBreakdownEditor
        idPrefix="test-mortgage"
        amountCents={amountCents}
        mortgageId="m1"
        propertyId="p1"
        value={value}
        onChange={setValue}
        categoryOptions={categoryOptions}
        escrowNote={escrowNote}
      />
      <button disabled={!valid} aria-describedby={mortgageBreakdownStatusId('test-mortgage')}>
        Save
      </button>
    </div>
  );
}

function renderHarness(amountCents = AMOUNT_CENTS, escrowNote?: string | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness amountCents={amountCents} escrowNote={escrowNote} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MortgageBreakdownEditor', () => {
  it('shows the read-only total and the "why principal is separate" hint', () => {
    stubTransactionsList([]);
    renderHarness();

    expect(screen.getByText('Total (from your bank)')).toBeInTheDocument();
    expect(screen.getByText('$2,400.00')).toBeInTheDocument();
    expect(screen.getByText("Principal repays the loan, so it isn't an expense.")).toBeInTheDocument();
    // The total is a static readout, not an input — nothing to accidentally edit.
    expect(screen.queryByLabelText('Total (from your bank)')).not.toBeInTheDocument();
  });

  it('defaults to a single "Remainder category" picker (no split rows) — choosing one is enough to enable Save', async () => {
    stubTransactionsList([]);
    renderHarness();

    fireEvent.change(await screen.findByLabelText(/^Principal/), { target: { value: '800.00' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText('Choose a category for the $1,600.00 remaining.')).toBeInTheDocument();
    // A single-category remainder never requires a second, invented category —
    // no split rows exist until the user opts into splitting.
    expect(screen.queryByLabelText('Category 1')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Remainder category'), { target: { value: 'c-interest' } });
    expect(
      screen.getByText('$1,600.00 will be categorized as the remainder category below.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });

  it('"Split across categories" reveals two rows, blocks Save until they sum to the remainder, and toggling back returns to the single picker', async () => {
    stubTransactionsList([]);
    renderHarness();

    fireEvent.change(await screen.findByLabelText(/^Principal/), { target: { value: '800.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split across categories' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(
      screen.getByText('$0.00 of $1,600.00 allocated · $1,600.00 remaining to allocate'),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Category 1'), { target: { value: 'c-interest' } });
    fireEvent.change(screen.getByLabelText('Amount 1 (USD)'), { target: { value: '1100.00' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Category 2'), { target: { value: 'c-tax' } });
    fireEvent.change(screen.getByLabelText('Amount 2 (USD)'), { target: { value: '500.00' } });

    expect(
      screen.getByText('$1,600.00 of $1,600.00 allocated · $0.00 remaining to allocate'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove split — use one category' }));
    expect(screen.getByLabelText('Remainder category')).toBeInTheDocument();
    expect(screen.queryByLabelText('Category 1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('names exactly which split row is still blocking Save when the sum already reconciles around it (defect: false "$0.00 remaining")', async () => {
    stubTransactionsList([]);
    renderHarness();

    // $2,400 total, $1,400 principal → $1,000 remainder. Row 1 alone already
    // sums to the remainder; row 2 is entirely untouched.
    fireEvent.change(await screen.findByLabelText(/^Principal/), { target: { value: '1400.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split across categories' }));
    fireEvent.change(screen.getByLabelText('Category 1'), { target: { value: 'c-interest' } });
    fireEvent.change(screen.getByLabelText('Amount 1 (USD)'), { target: { value: '1000.00' } });

    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeDisabled();
    // Never the misleading "fully allocated" text — names row 2 by name.
    expect(
      screen.queryByText('$1,000.00 of $1,000.00 allocated · $0.00 remaining to allocate'),
    ).not.toBeInTheDocument();
    const status = screen.getByText(
      '$1,000.00 of $1,000.00 allocated · row 2 still needs a category and amount',
    );
    expect(status).toBeInTheDocument();
    // The disabled button's aria-describedby resolves to this exact text.
    const describedById = saveButton.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById!)).toBe(status);

    // Finishing row 2 clears the block.
    fireEvent.change(screen.getByLabelText('Category 2'), { target: { value: 'c-tax' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText('$1,000.00 of $1,000.00 allocated · row 2 needs an amount over $0')).toBeInTheDocument();
  });

  it('explains that the remainder is usually interest plus escrowed taxes/insurance, with no separate "Escrow" category', async () => {
    stubTransactionsList([]);
    renderHarness();

    fireEvent.change(await screen.findByLabelText(/^Principal/), { target: { value: '800.00' } });
    const guidance = screen.getByText(
      (_, element) =>
        element?.tagName.toLowerCase() === 'p' &&
        /mortgage interest, plus any property taxes and insurance/i.test(element.textContent ?? '') &&
        /no separate/i.test(element.textContent ?? '') &&
        /Escrow/.test(element.textContent ?? '') &&
        /record those as/i.test(element.textContent ?? '') &&
        /Property Taxes/.test(element.textContent ?? '') &&
        /Insurance/.test(element.textContent ?? ''),
    );
    expect(guidance).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Interest + escrow (taxes, insurance)' }),
    ).toBeInTheDocument();
  });

  it('the interest + escrow affordance creates three rows (Mortgage Interest, Property Taxes, Insurance) with blank amounts — never computed', async () => {
    stubTransactionsList([]);
    renderHarness();

    fireEvent.change(await screen.findByLabelText(/^Principal/), { target: { value: '800.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Interest + escrow (taxes, insurance)' }));

    expect(screen.getByLabelText('Category 1')).toHaveValue('c-interest');
    expect(screen.getByLabelText('Amount 1 (USD)')).toHaveValue(null);
    expect(screen.getByLabelText('Category 2')).toHaveValue('c-tax');
    expect(screen.getByLabelText('Amount 2 (USD)')).toHaveValue(null);
    expect(screen.getByLabelText('Category 3')).toHaveValue('c-ins');
    expect(screen.getByLabelText('Amount 3 (USD)')).toHaveValue(null);
    // Not save-worthy yet — the user still has to type every amount (D4).
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it("surfaces the mortgage's own escrow note when the caller already has it loaded", async () => {
    stubTransactionsList([]);
    renderHarness(AMOUNT_CENTS, 'Taxes and insurance are escrowed with the monthly payment.');

    fireEvent.change(await screen.findByLabelText(/^Principal/), { target: { value: '800.00' } });
    expect(
      screen.getByText('Taxes and insurance are escrowed with the monthly payment.', { exact: false }),
    ).toBeInTheDocument();
  });

  it('accepts a principal-only payment (principal === total) with zero remainder and no categories to fill', async () => {
    stubTransactionsList([]);
    renderHarness();

    fireEvent.change(await screen.findByLabelText(/^Principal/), { target: { value: '2400.00' } });

    expect(
      screen.getByText('Principal covers the whole payment — nothing left to categorize.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Category 1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Remainder category')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });

  it("keeps the disabled Save button's aria-describedby resolvable even before Principal is typed", () => {
    stubTransactionsList([]);
    renderHarness();

    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeDisabled();
    const describedById = saveButton.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById!)).toHaveTextContent(
      'Enter the principal to see what still needs a category.',
    );
  });

  it("prefills from last month's own entry on the same mortgage and labels it plainly", async () => {
    stubTransactionsList([lastMonthPayment]);
    renderHarness();

    await waitFor(() => expect(screen.getByLabelText(/^Principal/)).toHaveValue(800));
    expect(
      screen.getByText('Same as last month — update from your statement if it changed.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Category 1')).toHaveValue('c-interest');
    expect(screen.getByLabelText('Amount 1 (USD)')).toHaveValue(1100);
    expect(screen.getByLabelText('Category 2')).toHaveValue('c-tax');
    expect(screen.getByLabelText('Amount 2 (USD)')).toHaveValue(500);
    // Fully accounted for, since the recalled figures already sum correctly.
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });

  it('has no axe violations in the initial blank state', async () => {
    stubTransactionsList([]);
    const { container } = renderHarness();
    await screen.findByLabelText(/^Principal/);

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });

  it('has no axe violations with the single remainder-category picker visible', async () => {
    stubTransactionsList([]);
    const { container } = renderHarness();

    fireEvent.change(await screen.findByLabelText(/^Principal/), { target: { value: '800.00' } });
    fireEvent.change(screen.getByLabelText('Remainder category'), { target: { value: 'c-interest' } });

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });

  it('has no axe violations with the remainder split rows visible', async () => {
    stubTransactionsList([]);
    const { container } = renderHarness();

    fireEvent.change(await screen.findByLabelText(/^Principal/), { target: { value: '800.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split across categories' }));
    fireEvent.change(screen.getByLabelText('Category 1'), { target: { value: 'c-interest' } });
    fireEvent.change(screen.getByLabelText('Amount 1 (USD)'), { target: { value: '1100.00' } });
    fireEvent.change(screen.getByLabelText('Category 2'), { target: { value: 'c-tax' } });
    fireEvent.change(screen.getByLabelText('Amount 2 (USD)'), { target: { value: '500.00' } });

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });

  it('has no axe violations with an incomplete split row named in the status text', async () => {
    stubTransactionsList([]);
    const { container } = renderHarness();

    fireEvent.change(await screen.findByLabelText(/^Principal/), { target: { value: '1400.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split across categories' }));
    fireEvent.change(screen.getByLabelText('Category 1'), { target: { value: 'c-interest' } });
    fireEvent.change(screen.getByLabelText('Amount 1 (USD)'), { target: { value: '1000.00' } });

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });

  it('has no axe violations after applying the interest + escrow affordance', async () => {
    stubTransactionsList([]);
    const { container } = renderHarness();

    fireEvent.change(await screen.findByLabelText(/^Principal/), { target: { value: '800.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Interest + escrow (taxes, insurance)' }));

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });
});

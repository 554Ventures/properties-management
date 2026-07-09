// Unit tests for the bank-import toast copy — pure function, no rendering.
import { describe, expect, it } from 'vitest';
import { importToastMessage } from '../pages/Money';

const zero = { imported: 0, skipped: 0, updated: 0, removed: 0 };

describe('importToastMessage', () => {
  it('reports new imports positively with the review-queue destination', () => {
    expect(importToastMessage({ ...zero, imported: 4 }, true)).toEqual({
      message: 'Imported 4 new bank transactions into the review queue.',
      tone: 'positive',
    });
  });

  it('singularizes a single import', () => {
    expect(importToastMessage({ ...zero, imported: 1 }, true).message).toBe(
      'Imported 1 new bank transaction into the review queue.',
    );
  });

  it('composes imported + updated + removed into one positive toast', () => {
    const { message, tone } = importToastMessage(
      { imported: 2, skipped: 3, updated: 1, removed: 1 },
      true,
    );
    expect(tone).toBe('positive');
    expect(message).toBe(
      'Imported 2 new bank transactions into the review queue. ' +
        'Updated 1 pending transaction with bank corrections. ' +
        'Removed 1 transaction voided by the bank.',
    );
  });

  it('reports updates/removals alone (no new imports) positively', () => {
    const { message, tone } = importToastMessage({ ...zero, updated: 1, removed: 1 }, true);
    expect(tone).toBe('positive');
    expect(message).toContain('Updated 1 pending transaction');
    expect(message).toContain('Removed 1 transaction voided by the bank.');
  });

  it('reports an all-skipped sync as already up to date (neutral)', () => {
    expect(importToastMessage({ ...zero, skipped: 4 }, true)).toEqual({
      message: 'Already up to date — 4 previously imported transactions unchanged.',
      tone: 'neutral',
    });
  });

  it('keeps the connected/not-connected empty-sync copy', () => {
    expect(importToastMessage(zero, true).message).toBe(
      'No new transactions yet — bank sync can take a minute after connecting. Try again shortly.',
    );
    expect(importToastMessage(zero, false).message).toBe('No new bank transactions to import.');
    expect(importToastMessage(zero, false).tone).toBe('neutral');
  });
});

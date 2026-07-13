// Toast copy for a bank-import result, shared by the Money page's manual
// "Import from bank" button and the post-connect auto-import in
// useStripeFcConnect.
import type { ImportTransactionsResponse } from '@hearth/shared';

export function importToastMessage(
  res: ImportTransactionsResponse,
  bankConnected: boolean,
): { message: string; tone: 'positive' | 'neutral' } {
  const s = (n: number) => (n === 1 ? '' : 's');
  const parts: string[] = [];
  if (res.imported > 0) {
    parts.push(`Imported ${res.imported} new bank transaction${s(res.imported)} into the review queue.`);
  }
  if (res.updated > 0) {
    parts.push(`Updated ${res.updated} pending transaction${s(res.updated)} with bank corrections.`);
  }
  if (res.removed > 0) {
    parts.push(`Removed ${res.removed} transaction${s(res.removed)} voided by the bank.`);
  }
  if (parts.length > 0) return { message: parts.join(' '), tone: 'positive' };
  if (res.skipped > 0) {
    return {
      message: `Already up to date — ${res.skipped} previously imported transaction${s(res.skipped)} unchanged.`,
      tone: 'neutral',
    };
  }
  return {
    message: bankConnected
      ? 'No new transactions yet — bank sync can take a minute after connecting. Try again shortly.'
      : 'No new bank transactions to import.',
    tone: 'neutral',
  };
}

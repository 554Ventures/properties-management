// Shared StatusBadge tone/label maps for lease and rent statuses — one source
// so Unit/Tenant/Property surfaces render identical badges for the same state.
import type { BadgeTone } from '../components/ui/StatusBadge';

export interface StatusBadgeSpec {
  tone: BadgeTone;
  label: string;
}

export const leaseStatusBadge: Record<string, StatusBadgeSpec> = {
  active: { tone: 'positive', label: 'Active' },
  pending_signature: { tone: 'warning', label: 'Pending signature' },
  ended: { tone: 'neutral', label: 'Ended' },
};

export const rentStatusBadge: Record<string, StatusBadgeSpec> = {
  paid: { tone: 'positive', label: 'Paid' },
  due: { tone: 'neutral', label: 'Due' },
  processing: { tone: 'neutral', label: 'Processing' },
  failed: { tone: 'danger', label: 'Failed' },
  late: { tone: 'danger', label: 'Late' },
};

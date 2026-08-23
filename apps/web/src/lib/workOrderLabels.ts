// Shared status/priority label + tone maps for work orders, used by the three
// Phase-2 ambient surfaces (property "Needs attention", UnitDetail history,
// ContractorDetail assigned work). The canonical /maintenance list + detail
// pages (Phase 1) keep their own local copies — this exists so the three new
// call sites don't each redeclare a fourth/fifth/sixth version.
import type { WorkOrderPriority, WorkOrderStatus } from '@hearth/shared';
import type { BadgeTone } from '../components/ui/StatusBadge';

export const WORK_ORDER_STATUS_LABEL: Record<WorkOrderStatus, string> = {
  open: 'Open',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const WORK_ORDER_STATUS_TONE: Record<WorkOrderStatus, BadgeTone> = {
  open: 'warning',
  scheduled: 'neutral',
  in_progress: 'neutral',
  completed: 'positive',
  cancelled: 'neutral',
};

export const WORK_ORDER_PRIORITY_LABEL: Record<WorkOrderPriority, string> = {
  emergency: 'Emergency',
  normal: 'Normal',
  low: 'Low',
};

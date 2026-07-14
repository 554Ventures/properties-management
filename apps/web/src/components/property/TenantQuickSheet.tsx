// Read-only tenant mini-profile opened from the units table: contact actions
// plus the tenant's role and rent share on the lease. Adaptive per the
// RowActions precedent — BottomSheet below md, small Modal at md+. No
// permission gating: everything here is a read or a device-level action.
import { formatUsd } from '@hearth/shared';
import type { TenantOnLease } from '@hearth/shared';
import { Link } from 'react-router-dom';
import { cx } from '../../lib/cx';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { BottomSheet } from '../ui/BottomSheet';
import { buttonClasses } from '../ui/Button';
import { Modal } from '../ui/Modal';

export interface TenantQuickSheetProps {
  tenant: TenantOnLease;
  onClose: () => void;
}

export function TenantQuickSheet({ tenant, onClose }: TenantQuickSheetProps) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const contactClasses = cx(buttonClasses('secondary'), 'w-full');

  const body = (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">
        {tenant.isPrimary ? 'Primary tenant' : 'Co-tenant'} ·{' '}
        {tenant.shareCents != null ? `${formatUsd(tenant.shareCents)}/mo share` : 'even split'}
      </p>
      <div className="flex flex-col gap-2">
        {tenant.phone ? (
          <>
            <a href={`tel:${tenant.phone}`} className={contactClasses}>
              Call {tenant.phone}
            </a>
            <a href={`sms:${tenant.phone}`} className={contactClasses}>
              Text {tenant.phone}
            </a>
          </>
        ) : (
          <p className="text-sm text-ink-muted">Phone not on file</p>
        )}
        {tenant.email ? (
          <a href={`mailto:${tenant.email}`} className={contactClasses}>
            Email {tenant.email}
          </a>
        ) : (
          <p className="text-sm text-ink-muted">Email not on file</p>
        )}
      </div>
      <div className="flex justify-end border-t border-border pt-3">
        <Link to={`/tenants/${tenant.id}`} className={buttonClasses('ghost', 'sm')}>
          Full profile →
        </Link>
      </div>
    </div>
  );

  if (isDesktop) {
    return (
      <Modal open onClose={onClose} title={tenant.fullName} size="sm">
        {body}
      </Modal>
    );
  }

  return (
    <BottomSheet open onClose={onClose} label={tenant.fullName} title={tenant.fullName}>
      <div className="px-2 pb-2">{body}</div>
    </BottomSheet>
  );
}

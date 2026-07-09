// A compact "quick add" tenant creator embedded inside the tenant-picker
// surfaces (create-lease roster, co-tenant manager) so you can add a brand-new
// tenant to a unit without leaving the flow. Full contact editing still lives in
// TenantFormModal / the tenant detail page — this captures the essentials.
//
// Renders as a plain <div> (never a nested <form>) so it can live inside the
// lease form; Enter in its fields adds the tenant rather than submitting the
// outer form.
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { Tenant } from '@hearth/shared';
import { useCreateTenant } from '../../api/queries';
import { Button } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';

export interface InlineNewTenantProps {
  /** Called with the created tenant after a successful POST /tenants. */
  onCreated: (tenant: Tenant) => void;
}

export function InlineNewTenant({ onCreated }: InlineNewTenantProps) {
  const create = useCreateTenant();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) {
      setFullName('');
      setEmail('');
      setPhone('');
      setError(undefined);
    }
  }, [open]);

  const submit = () => {
    if (!fullName.trim()) {
      setError('Enter the tenant’s name.');
      return;
    }
    setError(undefined);
    create.mutate(
      {
        fullName: fullName.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
      },
      {
        onSuccess: (tenant) => {
          onCreated(tenant);
          setOpen(false);
        },
        onError: (err) =>
          setError(err instanceof Error ? err.message : 'Could not add the tenant.'),
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        New tenant
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-sunken p-3">
      <FormField label="Full name" htmlFor={`${fieldId}-name`} error={error} required>
        <Input
          value={fullName}
          onInput={(e) => setFullName((e.target as HTMLInputElement).value)}
          onKeyDown={onKeyDown}
          autoComplete="name"
          autoFocus
        />
      </FormField>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Email" htmlFor={`${fieldId}-email`} hint="Optional.">
          <Input
            type="email"
            value={email}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
            onKeyDown={onKeyDown}
            autoComplete="email"
          />
        </FormField>
        <FormField label="Phone" htmlFor={`${fieldId}-phone`} hint="Optional.">
          <Input
            type="tel"
            value={phone}
            onInput={(e) => setPhone((e.target as HTMLInputElement).value)}
            onKeyDown={onKeyDown}
            autoComplete="tel"
          />
        </FormField>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" busy={create.isPending} onClick={submit}>
          Add tenant
        </Button>
      </div>
    </div>
  );
}

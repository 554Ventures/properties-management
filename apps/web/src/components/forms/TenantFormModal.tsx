// Create / edit a tenant's contact record.
import { useEffect, useState, type FormEvent } from 'react';
import type { Tenant } from '@hearth/shared';
import { useCreateTenant, useUpdateTenant } from '../../api/queries';
import { Button } from '../ui/Button';
import { FormField, Input, Textarea } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

type Mode = 'create' | 'edit';

interface FormState {
  fullName: string;
  email: string;
  phone: string;
  notes: string;
}

function emptyForm(): FormState {
  return { fullName: '', email: '', phone: '', notes: '' };
}

function fromTenant(t: Tenant): FormState {
  return {
    fullName: t.fullName,
    email: t.email ?? '',
    phone: t.phone ?? '',
    notes: t.notes ?? '',
  };
}

export interface TenantFormModalProps {
  open: boolean;
  onClose: () => void;
  mode: Mode;
  /** Required in edit mode. */
  tenant?: Tenant;
}

export function TenantFormModal({ open, onClose, mode, tenant }: TenantFormModalProps) {
  const create = useCreateTenant();
  const update = useUpdateTenant();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (open) {
      setForm(mode === 'edit' && tenant ? fromTenant(tenant) : emptyForm());
      setError(undefined);
    }
  }, [open, mode, tenant]);

  const set = (key: keyof FormState) => (event: FormEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((prev) => ({ ...prev, [key]: (event.target as HTMLInputElement).value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.fullName.trim()) {
      setError('Enter the tenant’s name.');
      return;
    }
    const body = {
      fullName: form.fullName.trim(),
      email: form.email.trim() || undefined,
      phone: form.phone.trim() || undefined,
      notes: form.notes.trim() || undefined,
    };

    const onError = (err: unknown) =>
      toast(err instanceof Error ? err.message : 'Could not save the tenant.', 'danger');

    if (mode === 'edit' && tenant) {
      update.mutate(
        { id: tenant.id, ...body },
        {
          onSuccess: () => {
            toast('Tenant updated.', 'positive');
            onClose();
          },
          onError,
        },
      );
      return;
    }

    create.mutate(body, {
      onSuccess: () => {
        toast('Tenant added.', 'positive');
        onClose();
      },
      onError,
    });
  };

  const busy = create.isPending || update.isPending;

  return (
    <Modal open={open} onClose={onClose} title={mode === 'edit' ? 'Edit tenant' : 'Add tenant'} size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FormField label="Full name" htmlFor="tenant-name" error={error} required>
          <Input value={form.fullName} onInput={set('fullName')} autoComplete="name" />
        </FormField>
        <FormField label="Email" htmlFor="tenant-email" hint="Optional.">
          <Input type="email" value={form.email} onInput={set('email')} autoComplete="email" />
        </FormField>
        <FormField label="Phone" htmlFor="tenant-phone" hint="Optional.">
          <Input type="tel" value={form.phone} onInput={set('phone')} autoComplete="tel" />
        </FormField>
        <FormField label="Notes" htmlFor="tenant-notes" hint="Optional.">
          <Textarea value={form.notes} onInput={set('notes')} />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            {mode === 'edit' ? 'Save changes' : 'Add tenant'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

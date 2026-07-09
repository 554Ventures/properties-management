// Shared report actions: CSV/PDF export downloads (fetch-based so the auth
// header rides along — a plain anchor would 401 in production's Supabase auth
// mode) and the "Email accountant" modal (POST /reports/:id/email).
import { useState, type FormEvent } from 'react';
import { downloadFile } from '../../api/client';
import { useEmailReport } from '../../api/queries';
import { Button } from '../ui/Button';
import { FormField, Input } from '../ui/FormField';
import { IconDownload, IconMail } from '../ui/icons';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

export function ExportLinks({ reportId, formats = ['csv', 'pdf'] }: { reportId: string; formats?: Array<'csv' | 'pdf'> }) {
  const { toast } = useToast();
  const download = (format: 'csv' | 'pdf') => {
    downloadFile(`/reports/${reportId}/export?format=${format}`, `report.${format}`).catch(
      (err: unknown) =>
        toast(err instanceof Error ? err.message : 'Could not export the report.', 'danger'),
    );
  };
  return (
    <>
      {formats.map((format) => (
        <Button key={format} variant="secondary" size="sm" onClick={() => download(format)}>
          <IconDownload size={14} />
          Export {format.toUpperCase()}
        </Button>
      ))}
    </>
  );
}

export function EmailAccountantButton({ reportId }: { reportId: string }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const email = useEmailReport();
  const { toast } = useToast();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    email.mutate(
      { id: reportId, to },
      {
        onSuccess: () => {
          toast(`Report emailed to ${to}.`, 'positive');
          setOpen(false);
          setTo('');
        },
        onError: () => toast('Could not send the email. Try again.', 'danger'),
      },
    );
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <IconMail size={14} />
        Email accountant
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Email this report" size="sm">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FormField
            label="Accountant's email"
            htmlFor="email-report-to"
            hint="A copy of this report will be sent as an attachment."
            required
          >
            <Input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              autoComplete="email"
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" busy={email.isPending}>
              Send
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

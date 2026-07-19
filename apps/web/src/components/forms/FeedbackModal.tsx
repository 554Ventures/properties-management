// Beta "Send feedback" modal — reachable from the shell on every page
// (SideNav pinned row + mobile More sheet). Captures a category + free text
// and auto-attaches the route the user was on; the API stores it and emails
// the owner (fire-and-forget server-side).
import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { FeedbackCategorySchema } from '@hearth/shared';
import type { FeedbackCategory } from '@hearth/shared';
import { useSubmitFeedback } from '../../api/queries';
import { Button } from '../ui/Button';
import { FormField, Textarea } from '../ui/FormField';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

/** Readable labels for the shared FeedbackCategory enum. */
const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug: 'Bug',
  idea: 'Idea',
  other: 'Other',
};

export interface FeedbackModalProps {
  open: boolean;
  onClose: () => void;
}

export function FeedbackModal({ open, onClose }: FeedbackModalProps) {
  const submit = useSubmitFeedback();
  const { toast } = useToast();
  const { pathname } = useLocation();
  const [category, setCategory] = useState<FeedbackCategory>('idea');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (open) {
      setCategory('idea');
      setMessage('');
      setError(undefined);
    }
  }, [open]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim()) {
      setError('Enter a message before sending.');
      return;
    }
    submit.mutate(
      { category, message: message.trim(), pagePath: pathname },
      {
        onSuccess: () => {
          toast('Thanks — your feedback was sent.', 'positive');
          onClose();
        },
        onError: (err) =>
          toast(err instanceof Error ? err.message : 'Could not send your feedback.', 'danger'),
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Send feedback" size="sm">
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-ink">Category</legend>
          <div className="flex gap-4" role="radiogroup" aria-label="Category">
            {FeedbackCategorySchema.options.map((option) => (
              <label key={option} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="feedback-category"
                  value={option}
                  checked={category === option}
                  onChange={() => setCategory(option)}
                  className="h-4 w-4 border-border-strong text-brand"
                />
                <span>{CATEGORY_LABELS[option]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <FormField
          label="Your feedback"
          htmlFor="feedback-message"
          hint="The page you're on is included automatically."
          error={error}
          required
        >
          <Textarea
            value={message}
            onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)}
            maxLength={2000}
          />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={submit.isPending}>
            Send feedback
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// Toast notifications announced via a persistent aria-live="polite" region.
// ToastProvider wraps the app (main.tsx); ToastViewport is mounted once in
// AppShell so the live region exists before any toast appears.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cx } from '../../lib/cx';
import { IconAlertCircle, IconCheck, IconDot, IconX } from './icons';

export type ToastTone = 'positive' | 'danger' | 'neutral';

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  toast: (message: string, tone?: ToastTone) => void;
  toasts: ToastItem[];
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, tone: ToastTone = 'neutral') => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, tone }]);
      window.setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast, toasts, dismiss }), [toast, toasts, dismiss]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): Pick<ToastContextValue, 'toast'> {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return { toast: ctx.toast };
}

const toneStyles: Record<ToastTone, { icon: typeof IconCheck; accent: string }> = {
  positive: { icon: IconCheck, accent: 'text-positive' },
  danger: { icon: IconAlertCircle, accent: 'text-danger' },
  neutral: { icon: IconDot, accent: 'text-neutral' },
};

/** Mounted once (AppShell). The region itself is always in the DOM. */
export function ToastViewport() {
  const ctx = useContext(ToastContext);
  if (!ctx) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-20 right-4 z-[60] flex w-full max-w-xs flex-col gap-2 md:bottom-4"
    >
      {ctx.toasts.map((t) => {
        const { icon: Icon, accent } = toneStyles[t.tone];
        return (
          <div
            key={t.id}
            className="flex items-start gap-2 rounded-md border border-border bg-surface-raised px-3 py-2.5 text-sm text-ink shadow-overlay"
          >
            <span className={cx('mt-0.5 shrink-0', accent)}>
              <Icon size={14} />
            </span>
            <p className="flex-1">{t.message}</p>
            <button
              type="button"
              onClick={() => ctx.dismiss(t.id)}
              aria-label="Dismiss notification"
              className="shrink-0 rounded p-0.5 text-ink-muted transition-colors duration-fast hover:text-ink"
            >
              <IconX size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

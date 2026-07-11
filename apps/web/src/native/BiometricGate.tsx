// Face ID lock screen (iOS shell only). Fully opaque overlay above the app
// while locked; auto-attempts on mount and re-locks when the app goes
// inactive (@capacitor/app appStateChange). Failure state uses visible text,
// never color alone; design tokens only.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../components/ui/Button';
import { useFocusTrap } from '../components/ui/useFocusTrap';
import { authenticateBiometric, isBiometricLockEnabled } from './biometric';
import { isNativeApp } from './platform';

type GateState = 'unlocked' | 'locked' | 'failed';

export function BiometricGate() {
  const [state, setState] = useState<GateState>(() =>
    isNativeApp() && isBiometricLockEnabled() ? 'locked' : 'unlocked',
  );
  const attempting = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // Escape must not dismiss the lock — the no-op onClose keeps the trap up.
  useFocusTrap(state !== 'unlocked', panelRef, () => {});

  const attempt = useCallback(async () => {
    if (attempting.current) return;
    attempting.current = true;
    try {
      const ok = await authenticateBiometric('Unlock 554 Properties');
      setState(ok ? 'unlocked' : 'failed');
    } finally {
      attempting.current = false;
    }
  }, []);

  // Auto-attempt whenever we enter the locked state.
  useEffect(() => {
    if (state === 'locked') void attempt();
  }, [state, attempt]);

  // Re-lock when the app leaves the foreground (preference read at event time
  // so toggling in Settings takes effect without a relaunch).
  useEffect(() => {
    if (!isNativeApp()) return;
    let remove: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const handle = await App.addListener('appStateChange', ({ isActive }) => {
          if (!isActive && isBiometricLockEnabled()) setState('locked');
        });
        if (cancelled) void handle.remove();
        else remove = () => void handle.remove();
      } catch {
        // Version skew — no re-lock on background, gate still locks on launch.
      }
    })();
    return () => {
      cancelled = true;
      remove?.();
    };
  }, []);

  if (state === 'unlocked') return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="biometric-gate-title"
      tabIndex={-1}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-surface p-6 text-center"
    >
      <h1 id="biometric-gate-title" className="text-lg font-semibold text-ink">
        554 Properties is locked
      </h1>
      {state === 'failed' ? (
        <p className="text-sm text-ink-muted">
          Face ID didn&rsquo;t recognize you. Try again to unlock.
        </p>
      ) : (
        <p className="text-sm text-ink-muted">Unlock with Face ID to continue.</p>
      )}
      <Button onClick={() => void attempt()}>
        {state === 'failed' ? 'Try again' : 'Unlock with Face ID'}
      </Button>
    </div>,
    document.body,
  );
}

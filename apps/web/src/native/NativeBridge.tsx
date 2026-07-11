// Null-rendering mount point for the iOS shell's native concerns: push
// registration (once per launch, after a session exists — it sits inside
// AuthGate) and the Face ID lock overlay. Renders nothing in plain browsers.
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { BiometricGate } from './BiometricGate';
import { isNativeApp } from './platform';
import { initPushRegistration } from './push';

export function NativeBridge() {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const initialized = useRef(false);

  useEffect(() => {
    if (!isNativeApp() || initialized.current) return;
    initialized.current = true;
    void initPushRegistration((path) => navigateRef.current(path));
  }, []);

  if (!isNativeApp()) return null;
  return <BiometricGate />;
}

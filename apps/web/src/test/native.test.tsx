// Native module (iOS shell) behavior with the Capacitor bridge mocked:
// plain web renders none of it, native registers the device and follows push
// deep links, and the BiometricGate locks/unlocks with zero axe violations
// (a11y is merge-blocking).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BiometricGate } from '../native/BiometricGate';
import { setBiometricLockEnabled } from '../native/biometric';
import { NativeBridge } from '../native/NativeBridge';
import { getCachedPushToken } from '../native/push';
import { removeLocal } from '../native/storage';

let mockNative = false;
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => mockNative },
}));

const mockPushListeners: Record<string, (arg: never) => void> = {};
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    addListener: vi.fn(async (event: string, cb: (arg: never) => void) => {
      mockPushListeners[event] = cb;
      return { remove: async () => {} };
    }),
    checkPermissions: vi.fn(async () => ({ receive: 'granted' })),
    requestPermissions: vi.fn(async () => ({ receive: 'granted' })),
    // Registering immediately delivers a token, like APNs on a real device.
    register: vi.fn(async () => {
      mockPushListeners['registration']?.({ value: 'tok_native_test' } as never);
    }),
  },
}));

let mockBiometricOk = true;
vi.mock('@aparajita/capacitor-biometric-auth', () => ({
  BiometricAuth: {
    authenticate: vi.fn(async () => {
      if (!mockBiometricOk) throw new Error('biometry failed');
    }),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: async () => {} })) },
}));

function stubFetch() {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 'pd1' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="pathname">{location.pathname}</output>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  mockNative = false;
  mockBiometricOk = true;
  setBiometricLockEnabled(false);
  removeLocal('hearth.pushToken');
  for (const key of Object.keys(mockPushListeners)) delete mockPushListeners[key];
});

describe('NativeBridge on plain web', () => {
  it('renders nothing and never touches the bridge or the API', async () => {
    const fetchMock = stubFetch();
    const { container } = render(
      <MemoryRouter>
        <NativeBridge />
      </MemoryRouter>,
    );
    expect(container.innerHTML).toBe('');
    // Give any stray async init a tick to (incorrectly) fire.
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockPushListeners['registration']).toBeUndefined();
  });
});

describe('NativeBridge on the iOS shell', () => {
  it('registers the APNs token with POST /devices and caches it for sign-out', async () => {
    mockNative = true;
    const fetchMock = stubFetch();
    render(
      <MemoryRouter>
        <NativeBridge />
      </MemoryRouter>,
    );
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/v1/devices'));
      expect(call).toBeDefined();
      expect(call![1]?.method).toBe('POST');
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        platform: 'ios',
        token: 'tok_native_test',
      });
    });
    await waitFor(() => {
      expect(getCachedPushToken()).toBe('tok_native_test');
    });
  });

  it('navigates to in-app deep links from notification taps, ignoring absolute URLs', async () => {
    mockNative = true;
    stubFetch();
    render(
      <MemoryRouter initialEntries={['/']}>
        <NativeBridge />
        <LocationProbe />
      </MemoryRouter>,
    );
    await waitFor(() => expect(mockPushListeners['pushNotificationActionPerformed']).toBeDefined());

    act(() => {
      mockPushListeners['pushNotificationActionPerformed']!({
        notification: { data: { deepLink: 'https://evil.example/phish' } },
      } as never);
    });
    expect(screen.getByTestId('pathname')).toHaveTextContent('/');

    act(() => {
      mockPushListeners['pushNotificationActionPerformed']!({
        notification: { data: { deepLink: '/rent' } },
      } as never);
    });
    expect(screen.getByTestId('pathname')).toHaveTextContent('/rent');
  });
});

describe('BiometricGate', () => {
  it('stays down when the lock preference is off', () => {
    mockNative = true;
    render(<BiometricGate />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('locks with a failed attempt showing visible retry text, unlocks on success — no axe violations', async () => {
    mockNative = true;
    mockBiometricOk = false;
    setBiometricLockEnabled(true);
    render(<BiometricGate />);

    // Auto-attempt failed → dialog with visible failure text (not color-only).
    const dialog = await screen.findByRole('dialog');
    await screen.findByText(/didn.t recognize you/i);
    expect(dialog).toHaveAccessibleName(/554 Properties is locked/i);

    const results = await axe.run(dialog, {
      rules: { 'color-contrast': { enabled: false } }, // jsdom can't compute this
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);

    mockBiometricOk = true;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

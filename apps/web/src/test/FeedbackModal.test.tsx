// FeedbackModal: a blank submit shows the inline FormField error without ever
// calling the API; a valid submit POSTs the category + message with the
// current route as pagePath, toasts success, and closes the modal.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackModal } from '../components/forms/FeedbackModal';
import { ToastProvider, ToastViewport } from '../components/ui/Toast';

function renderModal({ initialPath = '/', onClose = () => {} } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <FeedbackModal open onClose={onClose} />
          <ToastViewport />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FeedbackModal', () => {
  it('shows an inline error on blank submit without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));

    expect(await screen.findByText('Enter a message before sending.')).toBeTruthy();
    // The error is wired to the textarea via aria-describedby (FormField).
    const textarea = screen.getByLabelText(/Your feedback/);
    expect(textarea.getAttribute('aria-describedby')).toContain('feedback-message-error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits the current route as pagePath, toasts success, and closes', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(
        {
          id: 'fb1',
          accountId: 'acc1',
          userId: 'u1',
          category: 'bug',
          message: 'The rent chart is blank.',
          pagePath: '/rent',
          userAgent: 'vitest',
          createdAt: '2026-07-18T00:00:00.000Z',
        },
        201,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    renderModal({ initialPath: '/rent', onClose });

    fireEvent.click(screen.getByRole('radio', { name: 'Bug' }));
    fireEvent.input(screen.getByLabelText(/Your feedback/), {
      target: { value: 'The rent chart is blank.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/feedback');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(
      JSON.stringify({ category: 'bug', message: 'The rent chart is blank.', pagePath: '/rent' }),
    );
    expect(await screen.findByText('Thanks — your feedback was sent.')).toBeTruthy();
  });
});

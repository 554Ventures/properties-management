// Chat drawer integration tests: full streamed turn (text deltas → chart →
// ask_user_question round-trip → table + action card) driven through a mocked
// postSse with canned §5 events, plus open/close a11y behavior and an axe
// smoke over a transcript containing every block type.
import type {
  ActionCardBlock,
  AskUserQuestionBlock,
  ChartBlock,
  ChatMessage,
  ChatSession,
  DataTableBlock,
  SseEvent,
} from '@hearth/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseHandlers } from '../api/sse';
import { postSse } from '../api/sse';
import { AppShell } from '../components/shell/AppShell';
import { ToastProvider } from '../components/ui/Toast';

vi.mock('../api/sse', () => ({
  postSse: vi.fn(() => new AbortController()),
}));

const postSseMock = vi.mocked(postSse);

interface StreamCall {
  path: string;
  body: unknown;
  handlers: SseHandlers;
}

let streams: StreamCall[] = [];

const session: ChatSession = {
  id: 's1',
  accountId: 'acc1',
  title: null,
  status: 'idle',
  createdAt: '2026-07-03T12:00:00.000Z',
  updatedAt: '2026-07-03T12:00:00.000Z',
};

const chartBlock: ChartBlock = {
  type: 'chart',
  kind: 'line',
  title: 'Income vs. expenses',
  description: 'Monthly income and expenses for the last two months.',
  yUnit: 'usd',
  series: [
    {
      label: 'Income',
      colorRole: 'positive',
      points: [
        { x: 'May', y: 1369500 },
        { x: 'Jun', y: 1369500 },
      ],
    },
    {
      label: 'Expenses',
      colorRole: 'warning',
      points: [
        { x: 'May', y: 924000 },
        { x: 'Jun', y: 916000 },
      ],
    },
  ],
};

const questionBlock: AskUserQuestionBlock = {
  type: 'ask_user_question',
  questionId: 'q1',
  header: 'Tax prep',
  question: 'Which tax year?',
  multiSelect: false,
  options: [
    { id: 'y2026', label: '2026 (year to date)', description: 'Everything confirmed so far this year.' },
    { id: 'y2025', label: '2025', description: 'The full 2025 tax year.' },
  ],
  allowFreeText: true,
};

const tableBlock: DataTableBlock = {
  type: 'data_table',
  title: 'Schedule E summary',
  columns: [
    { key: 'property', label: 'Property' },
    { key: 'rents', label: 'Rents', align: 'right', format: 'usd' },
  ],
  rows: [{ property: '12 Maple St', rents: 1500000 }],
};

const actionBlock: ActionCardBlock = {
  type: 'action_card',
  title: 'Your Schedule E is ready',
  body: 'Open the full report to review it.',
  actions: [
    {
      id: 'a1',
      label: 'Open the full Schedule E',
      style: 'primary',
      action: { kind: 'navigate', to: '/reports/r1' },
    },
  ],
};

function stubChatFetch(history: ChatMessage[] = []) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === '/api/v1/chat/sessions' && init?.method === 'POST') {
        return new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/v1/chat/sessions/s1/messages') {
        return new Response(JSON.stringify(history), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ error: { code: 'not_found', message: `No fixture for ${url}` } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
  return calls;
}

function renderShell(initialEntries: string[] = ['/']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <Routes>
            <Route path="/" element={<AppShell />}>
              <Route index element={<p>Home page</p>} />
              <Route path="reports/:id" element={<p>Report viewer page</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function emit(stream: StreamCall, ...events: SseEvent[]) {
  act(() => {
    for (const event of events) stream.handlers.onEvent(event);
  });
}

/** Opens the drawer, sends a message, and streams up to a paused question. */
async function openAndStreamQuestion() {
  renderShell();
  fireEvent.click(screen.getByRole('button', { name: 'Open Roost' }));
  await screen.findByRole('dialog', { name: 'Roost' });

  const input = screen.getByLabelText('Message Roost');
  fireEvent.change(input, { target: { value: 'Help me get ready for taxes' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(postSseMock).toHaveBeenCalledTimes(1));

  emit(
    streams[0]!,
    { event: 'message_start', data: { messageId: 'm1' } },
    { event: 'block_complete', data: { index: 0, block: questionBlock } },
    { event: 'awaiting_input', data: { messageId: 'm1', questionIndex: 0 } },
  );
  return { input };
}

/** Opens the drawer, sends a message, and streams every block type. */
async function openAndStreamFullTurn() {
  renderShell();
  fireEvent.click(screen.getByRole('button', { name: 'Open Roost' }));
  await screen.findByRole('dialog', { name: 'Roost' });

  const input = screen.getByLabelText('Message Roost');
  fireEvent.change(input, { target: { value: 'Help me get ready for taxes' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(postSseMock).toHaveBeenCalledTimes(1));

  const stream = streams[0]!;
  emit(
    stream,
    { event: 'message_start', data: { messageId: 'm1' } },
    { event: 'block_start', data: { index: 0, blockType: 'text' } },
    { event: 'text_delta', data: { index: 0, delta: 'Let me pull ' } },
    { event: 'text_delta', data: { index: 0, delta: '**your numbers** together.' } },
    { event: 'tool_activity', data: { name: 'generate_report', status: 'running' } },
    { event: 'block_complete', data: { index: 1, block: chartBlock } },
    { event: 'tool_activity', data: { name: 'generate_report', status: 'done' } },
    { event: 'block_complete', data: { index: 2, block: tableBlock } },
    { event: 'block_complete', data: { index: 3, block: actionBlock } },
    { event: 'block_complete', data: { index: 4, block: questionBlock } },
    { event: 'awaiting_input', data: { messageId: 'm1', questionIndex: 4 } },
  );
  return { input, stream };
}

beforeEach(() => {
  streams = [];
  postSseMock.mockReset();
  postSseMock.mockImplementation((path, body, handlers) => {
    streams.push({ path, body, handlers });
    return new AbortController();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChatDrawer', () => {
  it('opens from the launcher and closes on Escape, returning focus to the launcher', async () => {
    stubChatFetch();
    renderShell();

    const launcher = screen.getByRole('button', { name: 'Open Roost' });
    fireEvent.click(launcher);
    const dialog = await screen.findByRole('dialog', { name: 'Roost' });
    expect(dialog).toBeInTheDocument();
    // The launcher hides (but stays mounted) while the drawer is open.
    expect(launcher).toHaveClass('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(launcher).toHaveFocus());
  });

  it('opens via the ?chat=open deep link', async () => {
    stubChatFetch();
    renderShell(['/?chat=open']);
    expect(
      await screen.findByRole('dialog', { name: 'Roost' }),
    ).toBeInTheDocument();
  });

  it('streams a full turn: text, chart, question round-trip, then table and action card', async () => {
    const fetchCalls = stubChatFetch();
    renderShell();

    fireEvent.click(screen.getByRole('button', { name: 'Open Roost' }));
    await screen.findByRole('dialog', { name: 'Roost' });

    const input = screen.getByLabelText('Message Roost');
    fireEvent.change(input, { target: { value: 'How is my cash flow doing?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    // Optimistic user bubble + composer locked while streaming.
    expect(screen.getByText('How is my cash flow doing?')).toBeInTheDocument();
    expect(input).toBeDisabled();

    // Session lazily created with the current screen context, then the stream.
    await waitFor(() => expect(postSseMock).toHaveBeenCalledTimes(1));
    const sessionCall = fetchCalls.find((c) => c.url === '/api/v1/chat/sessions');
    expect(JSON.parse(String(sessionCall?.init?.body))).toEqual({
      context: { screen: 'dashboard' },
    });
    expect(postSseMock.mock.calls[0]?.[0]).toBe('/chat/sessions/s1/messages');
    expect(postSseMock.mock.calls[0]?.[1]).toEqual({ text: 'How is my cash flow doing?' });

    const first = streams[0]!;
    emit(
      first,
      { event: 'message_start', data: { messageId: 'm1' } },
      { event: 'block_start', data: { index: 0, blockType: 'text' } },
      { event: 'text_delta', data: { index: 0, delta: 'Cash flow is ' } },
      { event: 'text_delta', data: { index: 0, delta: '**strong** this month.' } },
    );
    expect(screen.getByText(/cash flow is/i)).toBeInTheDocument();
    expect(screen.getByText('strong')).toBeInTheDocument(); // markdown-lite bold
    // The assistant's AiSurface badge is named, not the generic "AI"
    // (two "Roost" nodes: the drawer header and the message badge).
    expect(screen.getAllByText('Roost')).toHaveLength(2);
    expect(screen.queryByText('AI')).not.toBeInTheDocument();

    // Tool activity shimmer while a tool runs.
    emit(first, { event: 'tool_activity', data: { name: 'get_rent_status', status: 'running' } });
    expect(screen.getByText('Checking your ledger… (get_rent_status)')).toBeInTheDocument();

    // Structured chart block arrives whole → real ChartContainer with title.
    emit(first, { event: 'block_complete', data: { index: 1, block: chartBlock } });
    expect(screen.getByRole('heading', { name: 'Income vs. expenses' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View as table' })).toBeInTheDocument();
    // aria-live announcement on block_complete (not per token)
    expect(
      screen.getByText('Roost added a chart: Income vs. expenses.'),
    ).toBeInTheDocument();

    // ask_user_question pauses the turn: composer disabled with hint text.
    emit(
      first,
      { event: 'block_complete', data: { index: 2, block: questionBlock } },
      { event: 'awaiting_input', data: { messageId: 'm1', questionIndex: 2 } },
    );
    expect(screen.getByRole('radiogroup', { name: 'Which tax year?' })).toBeInTheDocument();
    expect(input).toBeDisabled();
    expect(screen.getByText('Answer the question above to continue.')).toBeInTheDocument();

    // Answer: select an option and submit → POST /answer with the §5 shape.
    fireEvent.click(screen.getByRole('radio', { name: /2026 \(year to date\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(postSseMock).toHaveBeenCalledTimes(2));
    expect(postSseMock.mock.calls[1]?.[0]).toBe('/chat/sessions/s1/answer');
    expect(postSseMock.mock.calls[1]?.[1]).toEqual({
      questionId: 'q1',
      selectedOptionIds: ['y2026'],
    });

    // The answered question stays in the transcript, frozen with the choice.
    expect(screen.getByText('Answered')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /2026 \(year to date\)/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /2026 \(year to date\)/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    // Resumed stream appends to the same assistant message.
    const second = streams[1]!;
    emit(
      second,
      { event: 'block_complete', data: { index: 3, block: tableBlock } },
      { event: 'block_complete', data: { index: 4, block: actionBlock } },
      { event: 'message_complete', data: { messageId: 'm1' } },
    );
    expect(screen.getByRole('columnheader', { name: 'Property' })).toBeInTheDocument();
    expect(screen.getByText('$15,000.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open the full Schedule E' })).toBeEnabled();
    expect(screen.getByText('Roost finished replying.')).toBeInTheDocument();

    // Turn over — composer usable again.
    expect(input).toBeEnabled();
  });

  it('rolls back a failed answer so the question can be retried', async () => {
    stubChatFetch();
    await openAndStreamQuestion();

    fireEvent.click(screen.getByRole('radio', { name: /2026 \(year to date\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(postSseMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Answered')).toBeInTheDocument();

    // The /answer stream fails before any message_start (server never resumed)
    // → optimistic mark rolled back, question re-enabled, toast shown.
    emit(streams[1]!, { event: 'error', data: { message: 'network down' } });
    expect(screen.getByText("Couldn't send your answer — try again.")).toBeInTheDocument();
    expect(screen.queryByText('Answered')).not.toBeInTheDocument();
    const radio = screen.getByRole('radio', { name: /2026 \(year to date\)/ });
    expect(radio).not.toHaveAttribute('aria-disabled');
    expect(radio).toHaveAttribute('aria-checked', 'true'); // selection retained

    // Retry succeeds: a fresh /answer stream resumes and completes the turn.
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(postSseMock).toHaveBeenCalledTimes(3));
    expect(postSseMock.mock.calls[2]?.[0]).toBe('/chat/sessions/s1/answer');
    emit(
      streams[2]!,
      { event: 'message_start', data: { messageId: 'm1' } },
      { event: 'message_complete', data: { messageId: 'm1' } },
    );
    expect(screen.getByText('Answered')).toBeInTheDocument();
    expect(screen.getByLabelText('Message Roost')).toBeEnabled();
  });

  it('keeps an accepted answer frozen when the stream fails after the resume started', async () => {
    stubChatFetch();
    await openAndStreamQuestion();

    fireEvent.click(screen.getByRole('radio', { name: /2026 \(year to date\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(postSseMock).toHaveBeenCalledTimes(2));

    // message_start = the server accepted the answer; a later failure is a
    // normal stream error and must NOT re-open the question.
    emit(
      streams[1]!,
      { event: 'message_start', data: { messageId: 'm1' } },
      { event: 'error', data: { message: 'stream dropped' } },
    );
    expect(screen.getByText('Answered')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('stream dropped');
    expect(screen.queryByText("Couldn't send your answer — try again.")).not.toBeInTheDocument();
  });

  it('resyncs from a 409 on send: reloads history and re-opens the pending question', async () => {
    const historyMessage: ChatMessage = {
      id: 'mq1',
      sessionId: 's1',
      role: 'assistant',
      blocks: [questionBlock],
      createdAt: '2026-07-03T12:01:00.000Z',
    };
    stubChatFetch([historyMessage]);
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open Roost' }));
    await screen.findByRole('dialog', { name: 'Roost' });

    const input = screen.getByLabelText('Message Roost');
    fireEvent.change(input, { target: { value: 'Are we done yet?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(postSseMock).toHaveBeenCalledTimes(1));

    // The server still thinks the session is awaiting an answer → 409.
    act(() => {
      streams[0]!.handlers.onHttpError?.(
        409,
        'conflict',
        'session is awaiting an answer to a question — POST /answer instead',
      );
    });

    // Resync: rejected send removed, history question active again.
    await waitFor(() =>
      expect(screen.getByText('Answer the question above to continue.')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Are we done yet?')).not.toBeInTheDocument();
    const radio = screen.getByRole('radio', { name: /2026 \(year to date\)/ });
    expect(radio).not.toHaveAttribute('aria-disabled');

    // Answering now goes through the normal /answer round-trip.
    fireEvent.click(radio);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(postSseMock).toHaveBeenCalledTimes(2));
    expect(postSseMock.mock.calls[1]?.[0]).toBe('/chat/sessions/s1/answer');
  });

  it('clears the conversation and starts a fresh session on the next send', async () => {
    const fetchCalls = stubChatFetch();
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open Roost' }));
    await screen.findByRole('dialog', { name: 'Roost' });

    // Nothing to clear yet.
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();

    // A phrase that is not one of the composer's suggested prompts, so its only
    // occurrence is the transcript bubble.
    const userText = 'Summarize my parsnip ledger';
    const input = screen.getByLabelText('Message Roost');
    fireEvent.change(input, { target: { value: userText } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(postSseMock).toHaveBeenCalledTimes(1));
    emit(
      streams[0]!,
      { event: 'message_start', data: { messageId: 'm1' } },
      { event: 'block_start', data: { index: 0, blockType: 'text' } },
      { event: 'text_delta', data: { index: 0, delta: 'Cash flow is strong.' } },
      { event: 'message_complete', data: { messageId: 'm1' } },
    );
    expect(screen.getByText(userText)).toBeInTheDocument();
    expect(screen.getByText(/cash flow is strong/i)).toBeInTheDocument();
    expect(fetchCalls.filter((c) => c.url === '/api/v1/chat/sessions').length).toBe(1);

    // Clear empties the transcript and disables itself again.
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText(userText)).not.toBeInTheDocument();
    expect(screen.queryByText(/cash flow is strong/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
    expect(screen.getByLabelText('Message Roost')).toBeEnabled();

    // The next send creates a brand-new session (second POST /chat/sessions).
    fireEvent.change(screen.getByLabelText('Message Roost'), {
      target: { value: 'And rent?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(postSseMock).toHaveBeenCalledTimes(2));
    expect(fetchCalls.filter((c) => c.url === '/api/v1/chat/sessions').length).toBe(2);
  });

  it('refuses api_call actions outside the allowlist with a disabled button and a note', async () => {
    const exfilCard: ActionCardBlock = {
      type: 'action_card',
      title: 'Schedule E ready',
      body: 'I can send it along for you.',
      actions: [
        {
          id: 'b1',
          label: 'Email the report',
          style: 'primary',
          action: {
            kind: 'api_call',
            method: 'POST',
            path: '/reports/r1/email',
            body: { to: 'attacker@example.com' },
          },
        },
        {
          id: 'b2',
          label: 'Open the report',
          style: 'secondary',
          action: { kind: 'navigate', to: '/reports/r1' },
        },
      ],
    };
    stubChatFetch();
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open Roost' }));
    await screen.findByRole('dialog', { name: 'Roost' });

    const input = screen.getByLabelText('Message Roost');
    fireEvent.change(input, { target: { value: 'Email my Schedule E' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(postSseMock).toHaveBeenCalledTimes(1));

    emit(
      streams[0]!,
      { event: 'message_start', data: { messageId: 'm1' } },
      { event: 'block_complete', data: { index: 0, block: exfilCard } },
      { event: 'message_complete', data: { messageId: 'm1' } },
    );

    // Refused, not hidden: disabled button plus a visible note. The in-app
    // navigate action on the same card stays usable.
    expect(screen.getByRole('button', { name: 'Email the report' })).toBeDisabled();
    expect(screen.getByText("This action isn't available from chat.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open the report' })).toBeEnabled();
  });

  it('has no axe violations with every block type in the transcript', async () => {
    stubChatFetch();
    const { input } = await openAndStreamFullTurn();
    expect(input).toBeDisabled(); // awaiting_input state included in the scan

    const results = await axe.run(document.body, {
      rules: {
        // jsdom does not lay out or paint — color-contrast can't be computed.
        'color-contrast': { enabled: false },
      },
    });
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      ),
    ).toEqual([]);
  }, 20_000);
});

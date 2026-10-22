// Request/response mapping for the two structured-output callers that had no
// coverage (weekly brief, reminder email), plus the thinking-block round trip
// through the AiClient seam. All three used to rely on a forced tool_choice,
// which current models reject with a 400; these assert the json_schema
// replacement and the fallbacks that keep a bad response harmless.
//
// Offline: '@anthropic-ai/sdk' is mocked at the module level, same pattern as
// receipt-extract.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));

import {
  buildWeeklyBriefRequest,
  createWeeklyBriefComposer,
  deterministicBrief,
  mockWeeklyBriefComposer,
  parseWeeklyBriefResponse,
  type WeeklyBriefFacts,
} from '../ai/weekly-brief';
import {
  buildReminderRequest,
  createReminderEmailComposer,
  deterministicDraft,
  mockReminderEmailComposer,
  parseReminderResponse,
  type ReminderEmailInput,
} from '../ai/reminder-email';

/** Structured outputs come back as a text block carrying the JSON object. */
function jsonContent(value: unknown) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

function facts(): WeeklyBriefFacts {
  return {
    accountId: 'acc1',
    weekStart: '2026-10-12T00:00:00.000Z',
    weekEnd: '2026-10-19T00:00:00.000Z',
    weekLabel: 'Oct 12 – Oct 18, 2026',
    period: '2026-10',
    rentCollectedCents: 480000,
    rentOutstandingCents: 120000,
    lateRows: [
      { tenantName: 'Okafor', rentPaymentId: 'rp1', daysLate: 6, owedCents: 120000 },
    ],
    pendingReviewCount: 3,
    newTransactionCount: 11,
    leasesEndingSoonCount: 1,
    warnings: [{ title: 'Insurance lapses in 20 days', actionTarget: null }],
    candidateActions: [
      { id: 'send-reminders', label: 'Send rent reminders', action: { kind: 'navigate', to: '/rent' } },
    ],
  };
}

function reminderInput(): ReminderEmailInput {
  return {
    accountId: 'acc1',
    tenantName: 'Dana Okafor',
    propertyLabel: '48 Maple St',
    unitLabel: 'Unit 2',
    amountCents: 120000,
    dueDate: '2026-10-01T00:00:00.000Z',
    period: '2026-10',
  };
}

beforeEach(() => {
  messagesCreate.mockReset();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

describe('buildWeeklyBriefRequest', () => {
  it('asks for the json schema instead of forcing a tool', () => {
    const req = buildWeeklyBriefRequest(facts());
    expect(req).not.toHaveProperty('tool_choice');
    expect(req).not.toHaveProperty('tools');
    expect(req.output_config?.format?.type).toBe('json_schema');
    expect(req.output_config?.format?.schema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({ headline: expect.anything() }),
    });
  });

  it('honors ANTHROPIC_MODEL and sends no sampling or thinking params', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-5-5';
    const req = buildWeeklyBriefRequest(facts());
    expect(req.model).toBe('claude-opus-5-5');
    expect(req).not.toHaveProperty('temperature');
    expect(req).not.toHaveProperty('top_p');
    expect(req).not.toHaveProperty('top_k');
    expect(req).not.toHaveProperty('thinking');
  });

  it('passes the figures and candidate action ids into the prompt', () => {
    const req = buildWeeklyBriefRequest(facts());
    const text = req.messages[0]!.content as string;
    expect(text).toContain('Okafor');
    expect(text).toContain('send-reminders');
  });
});

describe('parseWeeklyBriefResponse', () => {
  it('resolves a known candidate action id onto the item', () => {
    const f = facts();
    const result = parseWeeklyBriefResponse(
      jsonContent({
        headline: 'Rent is 80% collected',
        summary: 'Two tenants are late.',
        items: [
          { text: 'Chase Okafor', actionId: 'send-reminders' },
          { text: 'Review 3 imported transactions' },
        ],
      }) as never,
      f,
      deterministicBrief(f),
    );
    expect(result.headline).toBe('Rent is 80% collected');
    expect(result.items[0]!.action).toEqual({
      label: 'Send rent reminders',
      action: { kind: 'navigate', to: '/rent' },
    });
    expect(result.items[1]!.action).toBeNull();
  });

  it('drops an unknown action id to a plain-text item rather than inventing one', () => {
    const f = facts();
    const result = parseWeeklyBriefResponse(
      jsonContent({
        headline: 'H',
        summary: 'S',
        items: [
          { text: 'a', actionId: 'not-a-real-id' },
          { text: 'b' },
        ],
      }) as never,
      f,
      deterministicBrief(f),
    );
    expect(result.items[0]!.action).toBeNull();
  });

  it('falls back when the response is absent, unparseable, or schema-invalid', () => {
    const f = facts();
    const fallback = deterministicBrief(f);
    expect(parseWeeklyBriefResponse([] as never, f, fallback)).toBe(fallback);
    expect(
      parseWeeklyBriefResponse([{ type: 'text', text: 'not json' }] as never, f, fallback),
    ).toBe(fallback);
    // too few items (schema requires 2-4)
    expect(
      parseWeeklyBriefResponse(
        jsonContent({ headline: 'H', summary: 'S', items: [{ text: 'only one' }] }) as never,
        f,
        fallback,
      ),
    ).toBe(fallback);
    // blank headline
    expect(
      parseWeeklyBriefResponse(
        jsonContent({ headline: '   ', summary: 'S', items: [{ text: 'a' }, { text: 'b' }] }) as never,
        f,
        fallback,
      ),
    ).toBe(fallback);
  });
});

describe('buildReminderRequest', () => {
  it('asks for the json schema instead of forcing a tool', () => {
    const req = buildReminderRequest(reminderInput());
    expect(req).not.toHaveProperty('tool_choice');
    expect(req).not.toHaveProperty('tools');
    expect(req.output_config?.format?.type).toBe('json_schema');
    expect(req.output_config?.format?.schema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({ subject: expect.anything(), body: expect.anything() }),
    });
  });

  it('puts the tenant, amount and due date in the prompt', () => {
    const text = buildReminderRequest(reminderInput()).messages[0]!.content as string;
    expect(text).toContain('Dana Okafor');
    expect(text).toContain('$1,200.00');
    expect(text).toContain('October 1, 2026');
  });
});

describe('parseReminderResponse', () => {
  it('takes the drafted subject and body', () => {
    const fallback = deterministicDraft(reminderInput());
    const result = parseReminderResponse(
      jsonContent({ subject: 'Rent for Unit 2', body: 'Hi Dana,\n\nJust a nudge.' }) as never,
      fallback,
    );
    expect(result).toEqual({ subject: 'Rent for Unit 2', body: 'Hi Dana,\n\nJust a nudge.' });
  });

  it('falls back per-field when the model returns blanks', () => {
    const fallback = deterministicDraft(reminderInput());
    const result = parseReminderResponse(
      jsonContent({ subject: '  ', body: '  ' }) as never,
      fallback,
    );
    expect(result).toEqual(fallback);
  });

  it('falls back when the response is absent, unparseable, or schema-invalid', () => {
    const fallback = deterministicDraft(reminderInput());
    expect(parseReminderResponse([] as never, fallback)).toBe(fallback);
    expect(parseReminderResponse([{ type: 'text', text: '{{{' }] as never, fallback)).toBe(
      fallback,
    );
    expect(parseReminderResponse(jsonContent({ subject: 42 }) as never, fallback)).toBe(fallback);
  });
});

describe('composer factories', () => {
  it('return the deterministic composers without ANTHROPIC_API_KEY', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(createWeeklyBriefComposer()).toBe(mockWeeklyBriefComposer);
    expect(createReminderEmailComposer()).toBe(mockReminderEmailComposer);
  });

  it('weekly brief composer falls back to deterministic text on an API error', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    messagesCreate.mockRejectedValue(new Error('overloaded'));
    const f = facts();
    const result = await createWeeklyBriefComposer().compose(f);
    expect(result).toEqual(deterministicBrief(f));
  });

  it('reminder composer falls back to the template on an API error', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    messagesCreate.mockRejectedValue(new Error('overloaded'));
    const input = reminderInput();
    const result = await createReminderEmailComposer().compose(input);
    expect(result).toEqual(deterministicDraft(input));
  });
});

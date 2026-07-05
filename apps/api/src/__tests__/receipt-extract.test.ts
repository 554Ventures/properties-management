// Unit tests for the real receipt-vision extractor's request/response mapping —
// run entirely against a mocked '@anthropic-ai/sdk' (vi.mock at the module
// level, same pattern as real-plaid.test.ts) so they stay offline. The
// highest-risk correctness bugs are a dollars-vs-cents amount and a
// non-normalized date, so both are asserted explicitly below.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));

import { ReceiptScanFailedError } from '../lib/errors';
import {
  buildReceiptRequest,
  createReceiptExtractor,
  mockReceiptExtractor,
  parseReceiptToolUse,
  type ReceiptExtractionInput,
} from '../ai/receipt';
import { resolveByLabel, resolveByName } from '../services/transaction.service';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex'); // PNG magic bytes, content irrelevant

function extractionInput(): ReceiptExtractionInput {
  return {
    accountId: 'acc1',
    image: PNG,
    mimetype: 'image/png',
    categories: [{ name: 'Repairs' }, { name: 'Supplies' }],
    properties: [{ label: '48 Maple St' }, { label: 'Cedar Court' }],
  };
}

function toolUseContent(input: Record<string, unknown>) {
  return [{ type: 'tool_use', id: 'tu1', name: 'record_receipt', input }];
}

beforeEach(() => {
  messagesCreate.mockReset();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

describe('buildReceiptRequest', () => {
  it('puts the base64 image block before the text block and forces the tool', () => {
    const req = buildReceiptRequest(extractionInput());
    const content = req.messages[0]!.content as unknown as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
    });
    expect(content[1]).toMatchObject({ type: 'text' });
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'record_receipt' });
  });

  it('lists the category and property candidates in the prompt text', () => {
    const req = buildReceiptRequest(extractionInput());
    const text = (req.messages[0]!.content as Array<{ type: string; text?: string }>).find(
      (b) => b.type === 'text',
    )!.text!;
    expect(text).toContain('Repairs');
    expect(text).toContain('Supplies');
    expect(text).toContain('"48 Maple St"');
    expect(text).toContain('"Cedar Court"');
  });

  it('honors ANTHROPIC_MODEL and sends no sampling or thinking params', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8';
    const req = buildReceiptRequest(extractionInput());
    expect(req.model).toBe('claude-opus-4-8');
    expect(req).not.toHaveProperty('temperature');
    expect(req).not.toHaveProperty('top_p');
    expect(req).not.toHaveProperty('top_k');
    expect(req).not.toHaveProperty('thinking');
  });
});

describe('parseReceiptToolUse', () => {
  it('normalizes a happy-path extraction (date -> ISO UTC midnight)', () => {
    const result = parseReceiptToolUse(
      toolUseContent({
        vendor: 'ACE Hardware #2214',
        amount_cents: 4327,
        date: '2026-07-01',
        category_name: 'Repairs',
        property_label: '48 Maple St',
        confidence: 0.9,
      }) as never,
    );
    expect(result).toEqual({
      vendor: 'ACE Hardware #2214',
      amountCents: 4327,
      date: '2026-07-01T00:00:00.000Z',
      categoryName: 'Repairs',
      propertyLabel: '48 Maple St',
      confidence: 0.9,
    });
  });

  it('nulls a dollar-float or negative amount instead of guessing', () => {
    const base = {
      vendor: null,
      date: null,
      category_name: null,
      property_label: null,
      confidence: 0.5,
    };
    expect(
      parseReceiptToolUse(toolUseContent({ ...base, amount_cents: 43.27 }) as never).amountCents,
    ).toBeNull();
    expect(
      parseReceiptToolUse(toolUseContent({ ...base, amount_cents: -5 }) as never).amountCents,
    ).toBeNull();
  });

  it('nulls an unparseable date and clamps confidence', () => {
    const result = parseReceiptToolUse(
      toolUseContent({
        vendor: 'X',
        amount_cents: 100,
        date: 'July 1',
        category_name: null,
        property_label: null,
        confidence: 1.7,
      }) as never,
    );
    expect(result.date).toBeNull();
    expect(result.confidence).toBe(1);
  });

  it('degrades to all-nulls + confidence 0 when the tool call is missing or malformed', () => {
    const empty = {
      vendor: null,
      amountCents: null,
      date: null,
      categoryName: null,
      propertyLabel: null,
      confidence: 0,
    };
    expect(parseReceiptToolUse([{ type: 'text', text: 'no tool' }] as never)).toEqual(empty);
    expect(parseReceiptToolUse(toolUseContent({ vendor: 42 }) as never)).toEqual(empty);
  });
});

describe('createReceiptExtractor', () => {
  it('returns the mock extractor without ANTHROPIC_API_KEY', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(createReceiptExtractor()).toBe(mockReceiptExtractor);
  });

  it('real extractor maps the API response and logs aiUsage', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    messagesCreate.mockResolvedValue({
      model: 'claude-sonnet-5',
      usage: { input_tokens: 1200, output_tokens: 80 },
      content: toolUseContent({
        vendor: 'Reyes Plumbing',
        amount_cents: 21500,
        date: '2026-07-02',
        category_name: 'Repairs',
        property_label: null,
        confidence: 0.8,
      }),
    });
    const log = vi.fn();
    const extractor = createReceiptExtractor();
    const result = await extractor.extract({ ...extractionInput(), log });

    expect(result.vendor).toBe('Reyes Plumbing');
    expect(result.amountCents).toBe(21500);
    expect(result.date).toBe('2026-07-02T00:00:00.000Z');
    expect(log).toHaveBeenCalledWith(
      {
        aiUsage: {
          accountId: 'acc1',
          context: 'receipt_scan',
          model: 'claude-sonnet-5',
          inputTokens: 1200,
          outputTokens: 80,
        },
      },
      'ai token usage',
    );
  });

  it('real extractor wraps API errors in ReceiptScanFailedError', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    messagesCreate.mockRejectedValue(new Error('overloaded'));
    const extractor = createReceiptExtractor();
    await expect(extractor.extract(extractionInput())).rejects.toBeInstanceOf(
      ReceiptScanFailedError,
    );
  });
});

describe('name/label resolution', () => {
  const categories = [
    { id: 'c1', name: 'Repairs' },
    { id: 'c2', name: 'Supplies' },
  ];
  const properties = [{ id: 'p1', label: '48 Maple St' }];

  it('matches case-insensitively and trims', () => {
    expect(resolveByName('repairs', categories)).toBe('c1');
    expect(resolveByName('  SUPPLIES ', categories)).toBe('c2');
    expect(resolveByLabel('48 maple st', properties)).toBe('p1');
  });

  it('returns null for unknown or null names', () => {
    expect(resolveByName('Landscaping', categories)).toBeNull();
    expect(resolveByName(null, categories)).toBeNull();
    expect(resolveByLabel('99 Elm St', properties)).toBeNull();
  });
});

// Prompt caching is a prefix match, so these invariants are the whole feature:
// if any volatile value leaks into the static block, or the tool list stops
// being deterministic, caching silently stops working and nothing fails. The
// only symptom would be the bill. Hence the explicit tests.
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, type SystemPromptContext } from '../ai/prompts';
import { anthropicToolDefs } from '../ai/tools';

function ctx(over: Partial<SystemPromptContext> = {}): SystemPromptContext {
  return {
    accountName: 'Bien Rentals',
    propertyCount: 9,
    unitCount: 14,
    todayIso: '2026-10-21',
    period: '2026-10',
    ...over,
  };
}

describe('system prompt cache split', () => {
  it('puts the cache breakpoint on the static block only', () => {
    const [staticBlock, volatileBlock] = buildSystemPrompt(ctx());
    expect(staticBlock!.cache_control).toEqual({ type: 'ephemeral' });
    expect(volatileBlock!.cache_control).toBeUndefined();
  });

  it('keeps the static block byte-identical across accounts, dates and screens', () => {
    const a = buildSystemPrompt(ctx())[0]!.text;
    const b = buildSystemPrompt(
      ctx({
        accountName: 'Someone Else LLC',
        propertyCount: 1,
        unitCount: 2,
        todayIso: '2027-01-02',
        period: '2027-01',
        screen: { screen: 'rent', entityId: 'lease_1' },
      }),
    )[0]!.text;
    expect(a).toBe(b);
  });

  it('holds every volatile value in the second block, never the first', () => {
    const [staticBlock, volatileBlock] = buildSystemPrompt(
      // Distinctive sentinels: real screen names like "reports" legitimately
      // appear in the static rules, so a substring check needs values that
      // could only have come from the context.
      ctx({ accountName: 'Zzyzx Holdings', screen: { screen: 'zzscreen' } }),
    );
    for (const volatileValue of ['Zzyzx Holdings', '2026-10-21', '2026-10', 'zzscreen']) {
      expect(staticBlock!.text).not.toContain(volatileValue);
      expect(volatileBlock!.text).toContain(volatileValue);
    }
    // The counts are volatile too, but "9" and "14" are too short to assert
    // by substring — check the whole rendered sentence instead.
    expect(volatileBlock!.text).toContain('owns 9 properties with 14 units');
  });

  it('still carries the rules the assistant depends on', () => {
    const staticText = buildSystemPrompt(ctx())[0]!.text;
    expect(staticText).toContain('integer cents');
    expect(staticText).toContain('propose_action');
    expect(staticText).toContain('ask_user_question');
  });

  it('clears the minimum cacheable prefix with room to spare', () => {
    // Model-dependent minimum is 512-4096 tokens; below it, caching silently
    // no-ops. Tools render before system, so both count toward the prefix.
    // ~4 chars/token is good enough to catch an order-of-magnitude regression.
    const staticChars = buildSystemPrompt(ctx())[0]!.text.length;
    const toolChars = JSON.stringify(anthropicToolDefs()).length;
    expect(Math.round((staticChars + toolChars) / 4)).toBeGreaterThan(4096);
  });
});

describe('tool registry cacheability', () => {
  it('returns a deterministically ordered, user-independent list', () => {
    // Permissions are enforced at execution time, not by filtering this list —
    // filtering per user would give every member a different cache prefix.
    const a = anthropicToolDefs().map((t) => t.name);
    const b = anthropicToolDefs().map((t) => t.name);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

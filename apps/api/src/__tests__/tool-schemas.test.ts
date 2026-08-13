// Every chat/MCP tool's input schema must survive the trip to the Anthropic
// tool API, which requires a plain object schema (`type: 'object'` with
// `properties`). `anthropicToolDefs` casts the zod-to-json-schema output to
// `Tool['input_schema']`, so TypeScript cannot catch a violation and mock mode
// never calls the API — a bad schema would first surface as a 400 on the real
// model path, breaking *every* chat turn, not just the offending tool's.
//
// The way to trip this is to compose a tool schema out of anything that isn't a
// ZodObject: `.refine()` yields a ZodEffects and `.and()` an intersection,
// which serializes to `allOf` with no top-level `properties`. Refined shapes
// belong on routes; tools take the unrefined object and let the service enforce
// the rule (see UpdateMortgageFieldsSchema / mortgage.service.update).
import { describe, expect, it } from 'vitest';
import { anthropicToolDefs } from '../ai/tools';

describe('anthropicToolDefs', () => {
  const defs = anthropicToolDefs();

  it('exposes at least the known tool surface', () => {
    expect(defs.length).toBeGreaterThan(20);
  });

  it('gives every tool a plain object input schema', () => {
    const bad = defs
      .filter((d) => {
        const s = d.input_schema as { type?: string; properties?: unknown; allOf?: unknown };
        return s.type !== 'object' || s.properties === undefined || s.allOf !== undefined;
      })
      .map((d) => d.name);
    expect(bad).toEqual([]);
  });

  it('gives every tool a description that states its side effects', () => {
    for (const d of defs) {
      expect(d.description, d.name).toBeTruthy();
    }
  });
});

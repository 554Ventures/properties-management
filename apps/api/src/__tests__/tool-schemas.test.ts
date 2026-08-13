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
import {
  ConfirmTransactionInputSchema,
  CreateMortgageInputSchema,
  CreatePropertyValuationInputSchema,
  CreateRecurringTemplateInputSchema,
  CreateTransactionInputSchema,
} from '@hearth/shared';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { anthropicToolDefs, serviceTools } from '../ai/tools';

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

// A tool that mirrors a REST contract must not fall behind it. `confirm_transaction`
// did: the contract gained the mortgage breakdown (principalCents and the splits
// that must sum around it), the tool kept its own hand-written field list, and the
// assistant could only confirm a mortgage payment by expensing the entire debit —
// no principal carved out, no balance moved, and no error to notice. Typecheck
// can't see it (the tool declares an unrelated schema) and mock mode never
// exercises it.
//
// So each pairing below asserts the tool exposes every field of the contract it
// wraps. Deliberate omissions are listed explicitly, which is the point: leaving
// a field out becomes a decision someone wrote down rather than a silent gap.
describe('tools that wrap a REST contract expose all of its fields', () => {
  const pairings: Array<{
    tool: string;
    contract: z.ZodObject<z.ZodRawShape>;
    /** Fields the tool intentionally does not accept, and why. */
    omit?: Record<string, string>;
  }> = [
    {
      tool: 'confirm_transaction',
      contract: ConfirmTransactionInputSchema,
      omit: {
        linkSource:
          'decides whether a rent link audits as the user’s own choice — a model-invoked write must not claim that',
      },
    },
    { tool: 'create_transaction', contract: CreateTransactionInputSchema },
    { tool: 'create_mortgage', contract: CreateMortgageInputSchema },
    { tool: 'record_property_valuation', contract: CreatePropertyValuationInputSchema },
    { tool: 'create_recurring_template', contract: CreateRecurringTemplateInputSchema },
  ];

  const propsOf = (schema: z.ZodTypeAny): string[] => {
    const json = zodToJsonSchema(schema, { $refStrategy: 'none' }) as {
      properties?: Record<string, unknown>;
    };
    return Object.keys(json.properties ?? {});
  };

  for (const { tool, contract, omit = {} } of pairings) {
    it(`${tool} covers its contract`, () => {
      const def = serviceTools.find((t) => t.name === tool);
      expect(def, `${tool} is not registered`).toBeDefined();

      const exposed = new Set(propsOf(def!.inputSchema));
      const missing = propsOf(contract).filter((f) => !exposed.has(f) && !(f in omit));
      expect(missing, `${tool} is missing contract fields`).toEqual([]);

      // An omission that stops being true should fail too, so the list can't rot.
      for (const field of Object.keys(omit)) {
        expect(exposed.has(field), `${tool} now exposes deliberately-omitted "${field}"`).toBe(
          false,
        );
      }
    });
  }
});

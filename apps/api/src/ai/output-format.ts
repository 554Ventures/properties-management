// Shared builder for `output_config.format` — the structured-output schema the
// three non-chat callers (receipt, weekly brief, reminder email) use to pin
// their response shape. They used to force a tool call for this; current
// models reject forced tool_choice with a 400.
//
// Structured outputs accepts a SUBSET of JSON Schema, and the API rejects the
// whole request when a schema strays outside it — so a constraint that zod
// emits happily can take a feature offline. Both known array constraints are
// stripped here rather than removed from the zod schemas, because the zod
// schema is still what validates the *response*: the ceiling stays enforced on
// the parse side, it just isn't advertised to the model. Express a stripped
// constraint in the field's .describe() so the model still hears about it.
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export type JsonSchemaFormat = NonNullable<
  NonNullable<MessageCreateParamsNonStreaming['output_config']>['format']
>;

/**
 * Keywords structured outputs rejects, with the error each one produces:
 * - minItems: "For 'array' type, 'minItems' values other than 0 or 1 are not
 *   supported" (0 and 1 are legal, but stripping unconditionally keeps one rule)
 * - maxItems: "For 'array' type, property 'maxItems' is not supported"
 */
const UNSUPPORTED_KEYWORDS = ['minItems', 'maxItems'] as const;

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>)
        .filter(([key]) => !(UNSUPPORTED_KEYWORDS as readonly string[]).includes(key))
        .map(([key, value]) => [key, stripUnsupported(value)]),
    );
  }
  return node;
}

/** zod schema -> an `output_config.format` the API will accept. */
export function jsonSchemaFormat(schema: ZodTypeAny): JsonSchemaFormat {
  return {
    type: 'json_schema',
    schema: stripUnsupported(zodToJsonSchema(schema, { $refStrategy: 'none' })) as Record<
      string,
      unknown
    >,
  };
}

// Boundary validation helpers: parse request bodies/queries with the shared
// zod schemas. Thrown ZodErrors are turned into 400 ApiError responses by the
// error-handler plugin.
import type { z } from 'zod';

export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  return schema.parse(body ?? {});
}

export function parseQuery<S extends z.ZodTypeAny>(schema: S, query: unknown): z.infer<S> {
  return schema.parse(query ?? {});
}

/** Query strings arrive as strings — coerce named keys to numbers before parsing. */
export function coerceNumbers(
  query: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const out = { ...query };
  for (const key of keys) {
    const v = out[key];
    if (typeof v === 'string' && v !== '') out[key] = Number(v);
  }
  return out;
}

/**
 * Query strings arrive as strings — map the literal 'true'/'false' of named
 * keys to real booleans before parsing. Deliberately NOT z.coerce.boolean(),
 * which treats every non-empty string (including 'false') as true; any other
 * value is left as-is for the schema to reject.
 */
export function coerceBooleans(
  query: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const out = { ...query };
  for (const key of keys) {
    const v = out[key];
    if (v === 'true') out[key] = true;
    else if (v === 'false') out[key] = false;
  }
  return out;
}

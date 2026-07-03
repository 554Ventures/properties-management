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

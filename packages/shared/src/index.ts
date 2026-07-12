// @hearth/shared — API contract (Zod schemas + types).
// Populated per docs/ARCHITECTURE.md; both apps/api and apps/web import from here.

export * from './branding';
export * from './enums';
export * from './money';
// schemas/api re-exports every schema file (entities, composites, chat blocks,
// chat/SSE) plus ApiErrorSchema.
export * from './schemas/api';
export * from './types';

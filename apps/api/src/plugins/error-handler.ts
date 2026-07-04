// Maps errors onto the shared ApiError envelope:
//   zod → 400 with per-field messages; NotFound/Http → their status; else 500.
import type { ApiError } from '@hearth/shared';
import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors';

function zodFields(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const path = issue.path.join('.') || '(root)';
    if (!fields[path]) fields[path] = issue.message;
  }
  return fields;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const body: ApiError = {
        error: { code: 'validation_error', message: 'Request validation failed', fields: zodFields(err) },
      };
      return reply.code(400).send(body);
    }
    if (err instanceof HttpError) {
      const body: ApiError = { error: { code: err.code, message: err.message } };
      return reply.code(err.statusCode).send(body);
    }
    if ((err as { statusCode?: unknown }).statusCode === 429) {
      // @fastify/rate-limit errors, reshaped into the envelope.
      const message = err instanceof Error && err.message ? err.message : 'Too many requests';
      const body: ApiError = { error: { code: 'rate_limited', message } };
      return reply.code(429).send(body);
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      const body: ApiError = { error: { code: 'not_found', message: 'Record not found' } };
      return reply.code(404).send(body);
    }
    req.log.error(err);
    const body: ApiError = {
      error: { code: 'internal_error', message: 'Something went wrong' },
    };
    return reply.code(500).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const body: ApiError = {
      error: { code: 'not_found', message: `Route ${req.method} ${req.url} not found` },
    };
    return reply.code(404).send(body);
  });
}

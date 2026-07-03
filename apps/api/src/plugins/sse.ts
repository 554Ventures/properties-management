// Small SSE utilities for the (later) chat task: write `event:`/`data:`
// frames on a hijacked Fastify reply. Kept minimal on purpose.
import type { FastifyReply } from 'fastify';

/** Hijack the reply and send SSE headers. Call once, before any frame. */
export function sseStart(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

/** Write one `event:`/`data:` frame. */
export function sseSend(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function sseEnd(reply: FastifyReply): void {
  reply.raw.end();
}

import {
  CreateDocumentFieldsSchema,
  DocumentListQuerySchema,
  UpdateDocumentInputSchema,
} from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { BadRequestError } from '../lib/errors';
import { coerceNumbers, parseBody, parseQuery } from '../plugins/zod-validation';
import * as documentService from '../services/document.service';
import { sanitizeFilename } from '../services/document.service';

// Matches the global multipart cap in app.ts.
const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIMETYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

// Per-account limit — uploads move real bytes into storage (mirrors the
// receipt-scan limit in routes/transactions.ts).
function documentUploadLimit() {
  return {
    rateLimit: {
      max: Number(process.env.DOCUMENT_RATE_LIMIT_MAX ?? 30),
      timeWindow: '1 minute',
    },
  };
}

// RFC 6266/5987 content-disposition: ASCII fallback in filename= (Node rejects
// header values with chars > 0xFF), full UTF-8 name in filename*=.
function contentDisposition(disposition: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^ -~]/g, '_');
  const utf8 = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export async function documentsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/documents', { config: documentUploadLimit() }, async (req, reply) => {
    const file = await req.file();
    if (!file) throw new BadRequestError('multipart file field is required');
    if (!ALLOWED_MIMETYPES.has(file.mimetype)) {
      throw new BadRequestError(
        'Unsupported file type — upload a PDF, image (JPEG/PNG/WebP/GIF), or Word document.',
      );
    }
    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (err) {
      // The global multipart cap (app.ts) aborts oversize streams with a 413;
      // translate it into the same friendly 400 as the explicit check below.
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new BadRequestError('File too large — use a file under 10 MB.');
      }
      throw err;
    }
    if (buffer.length > DOCUMENT_MAX_BYTES) {
      throw new BadRequestError('File too large — use a file under 10 MB.');
    }
    // Text fields ride alongside the file part; each is a { value } object.
    const rawFields: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(file.fields)) {
      const f = Array.isArray(field) ? field[0] : field;
      if (f && 'value' in f) rawFields[key] = f.value;
    }
    const fields = parseBody(CreateDocumentFieldsSchema, rawFields);
    const document = await documentService.create(req.accountId, {
      entityType: fields.entityType,
      entityId: fields.entityId,
      type: fields.type,
      name: fields.name ?? file.filename,
      buffer,
      mimeType: file.mimetype,
    });
    return reply.code(201).send(document);
  });

  app.get('/documents', async (req) => {
    const q = parseQuery(
      DocumentListQuerySchema,
      coerceNumbers(req.query as Record<string, unknown>, ['limit']),
    );
    return documentService.list(req.accountId, q);
  });

  app.get<{ Params: { id: string } }>('/documents/:id/download', async (req, reply) => {
    const { name, mimeType, buffer } = await documentService.getForDownload(
      req.accountId,
      req.params.id,
    );
    // PDFs and images render in the browser; everything else downloads.
    const disposition =
      mimeType === 'application/pdf' || mimeType.startsWith('image/') ? 'inline' : 'attachment';
    return reply
      .header('content-type', mimeType)
      .header('content-disposition', contentDisposition(disposition, sanitizeFilename(name)))
      .send(buffer);
  });

  app.patch<{ Params: { id: string } }>('/documents/:id', async (req) => {
    const input = parseBody(UpdateDocumentInputSchema, req.body);
    return documentService.update(req.accountId, req.params.id, input);
  });

  app.delete<{ Params: { id: string } }>('/documents/:id', async (req, reply) => {
    await documentService.remove(req.accountId, req.params.id);
    return reply.code(204).send();
  });
}

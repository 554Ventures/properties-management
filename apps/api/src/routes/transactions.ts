import {
  ConfirmTransactionInputSchema,
  CreateTransactionInputSchema,
  TransactionListQuerySchema,
  UpdateTransactionInputSchema,
} from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { isReceiptImageMimetype } from '../ai/receipt';
import { BadRequestError } from '../lib/errors';
import { coerceNumbers, parseBody, parseQuery } from '../plugins/zod-validation';
import * as transactionService from '../services/transaction.service';

// Anthropic rejects images over ~5 MB; the global multipart cap is 10 MB.
const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

// Per-account limit — each scan can cost model tokens (deployment plan §4.5).
function receiptScanLimit() {
  return {
    rateLimit: {
      max: Number(process.env.RECEIPT_RATE_LIMIT_MAX ?? 10),
      timeWindow: '1 minute',
    },
  };
}

export async function transactionsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/transactions', async (req) => {
    const q = parseQuery(
      TransactionListQuerySchema,
      coerceNumbers(req.query as Record<string, unknown>, ['limit']),
    );
    return transactionService.list(req.accountId, q);
  });

  app.post('/transactions', async (req, reply) => {
    const input = parseBody(CreateTransactionInputSchema, req.body);
    const txn = await transactionService.create(req.accountId, input);
    return reply.code(201).send(txn);
  });

  // Static routes before the parameterized ones.
  app.get('/transactions/review', async (req) => transactionService.getReviewQueue(req.accountId));

  app.post('/transactions/receipt', { config: receiptScanLimit() }, async (req) => {
    const file = await req.file();
    if (!file) throw new BadRequestError('multipart image field is required');
    if (!isReceiptImageMimetype(file.mimetype)) {
      throw new BadRequestError('Unsupported image type — upload a JPEG, PNG, WebP, or GIF photo.');
    }
    const image = await file.toBuffer();
    if (image.length > RECEIPT_MAX_BYTES) {
      throw new BadRequestError('Image too large — use a photo under 5 MB.');
    }
    return transactionService.scanReceipt(req.accountId, image, file.mimetype, (data, message) =>
      req.log.info(data, message),
    );
  });

  app.post('/transactions/import', async (req) => transactionService.importFromBank(req.accountId));

  app.patch<{ Params: { id: string } }>('/transactions/:id', async (req) => {
    const input = parseBody(UpdateTransactionInputSchema, req.body);
    return transactionService.update(req.accountId, req.params.id, input);
  });

  app.delete<{ Params: { id: string } }>('/transactions/:id', async (req, reply) => {
    await transactionService.remove(req.accountId, req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/transactions/:id/confirm', async (req) => {
    const input = parseBody(ConfirmTransactionInputSchema, req.body);
    return transactionService.confirm(req.accountId, req.params.id, input);
  });
}

import {
  ConfirmTransactionInputSchema,
  CreateTransactionInputSchema,
  ReviewQueueFilterSchema,
  ReviewQueueQuerySchema,
  TransactionListQuerySchema,
  UpdateTransactionInputSchema,
} from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { isReceiptImageMimetype, RECEIPT_IMAGE_MIMETYPES, type ReceiptImageMimetype } from '../ai/receipt';
import { requirePermission } from '../lib/authz';
import { BadRequestError } from '../lib/errors';
import { UnverifiableFileTypeError, verifyFileContentType } from '../lib/file-sniff';
import { coerceBooleans, coerceNumbers, parseBody, parseQuery } from '../plugins/zod-validation';
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
  const needsMoney = { preHandler: requirePermission('money') };

  app.get('/transactions', async (req) => {
    const q = parseQuery(
      TransactionListQuerySchema,
      coerceBooleans(
        coerceNumbers(req.query as Record<string, unknown>, ['limit', 'offset']),
        ['unassigned'],
      ),
    );
    return transactionService.list(req.accountId, q);
  });

  app.post('/transactions', needsMoney, async (req, reply) => {
    const input = parseBody(CreateTransactionInputSchema, req.body);
    const txn = await transactionService.create(req.accountId, input);
    return reply.code(201).send(txn);
  });

  // Static routes before the parameterized ones.
  app.get('/transactions/review', async (req) => {
    const q = parseQuery(
      ReviewQueueQuerySchema,
      coerceNumbers(req.query as Record<string, unknown>, ['limit']),
    );
    return transactionService.getReviewQueue(req.accountId, q);
  });

  // Bulk actions take the same filter shape the queue was loaded with, so
  // "confirm all"/"dismiss all" apply to exactly the set the user is viewing.
  app.post('/transactions/review/confirm-all', needsMoney, async (req) => {
    const filter = parseBody(ReviewQueueFilterSchema, req.body ?? {});
    return transactionService.confirmAllInReview(req.accountId, filter);
  });

  app.post('/transactions/review/dismiss-all', needsMoney, async (req) => {
    const filter = parseBody(ReviewQueueFilterSchema, req.body ?? {});
    return transactionService.dismissAllInReview(req.accountId, filter);
  });

  app.post(
    '/transactions/receipt',
    { config: receiptScanLimit(), preHandler: requirePermission('money') },
    async (req) => {
    const file = await req.file();
    if (!file) throw new BadRequestError('multipart image field is required');
    if (!isReceiptImageMimetype(file.mimetype)) {
      throw new BadRequestError('Unsupported image type — upload a JPEG, PNG, WebP, or GIF photo.');
    }
    const image = await file.toBuffer();
    if (image.length > RECEIPT_MAX_BYTES) {
      throw new BadRequestError('Image too large — use a photo under 5 MB.');
    }
    // Verify actual image bytes — the declared Content-Type above is only a
    // fast pre-filter and is client-controlled (docs/SECURITY_PRIVACY_AUDIT.md §A11).
    let mimetype: ReceiptImageMimetype;
    try {
      mimetype = (await verifyFileContentType(image, RECEIPT_IMAGE_MIMETYPES)) as ReceiptImageMimetype;
    } catch (err) {
      if (err instanceof UnverifiableFileTypeError) {
        throw new BadRequestError('Unsupported image type — upload a JPEG, PNG, WebP, or GIF photo.');
      }
      throw err;
    }
    return transactionService.scanReceipt(req.accountId, image, mimetype, (data, message) =>
      req.log.info(data, message),
    );
  });

  app.post('/transactions/import', needsMoney, async (req) =>
    transactionService.importFromBank(req.accountId),
  );

  // Bank-sync discrepancies (post-confirm bank corrections). Static segment,
  // so registered before the parameterized /transactions/:id routes.
  app.get('/transactions/bank-discrepancies', async (req) =>
    transactionService.listBankDiscrepancies(req.accountId),
  );

  app.post<{ Params: { id: string } }>(
    '/transactions/bank-discrepancies/:id/accept',
    needsMoney,
    async (req) => transactionService.acceptBankDiscrepancy(req.accountId, req.params.id),
  );

  app.post<{ Params: { id: string } }>(
    '/transactions/bank-discrepancies/:id/dismiss',
    needsMoney,
    async (req) => transactionService.dismissBankDiscrepancy(req.accountId, req.params.id),
  );

  app.patch<{ Params: { id: string } }>('/transactions/:id', needsMoney, async (req) => {
    const input = parseBody(UpdateTransactionInputSchema, req.body);
    return transactionService.update(req.accountId, req.params.id, input);
  });

  app.delete<{ Params: { id: string } }>('/transactions/:id', needsMoney, async (req, reply) => {
    await transactionService.remove(req.accountId, req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/transactions/:id/confirm', needsMoney, async (req) => {
    const input = parseBody(ConfirmTransactionInputSchema, req.body);
    return transactionService.confirm(req.accountId, req.params.id, input);
  });

  app.post<{ Params: { id: string } }>('/transactions/:id/dismiss', needsMoney, async (req) =>
    transactionService.dismiss(req.accountId, req.params.id),
  );

  app.post<{ Params: { id: string } }>('/transactions/:id/restore', needsMoney, async (req) =>
    transactionService.restore(req.accountId, req.params.id),
  );
}

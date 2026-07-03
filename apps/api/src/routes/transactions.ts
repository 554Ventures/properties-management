import {
  ConfirmTransactionInputSchema,
  CreateTransactionInputSchema,
  TransactionListQuerySchema,
  UpdateTransactionInputSchema,
} from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { BadRequestError } from '../lib/errors';
import { coerceNumbers, parseBody, parseQuery } from '../plugins/zod-validation';
import * as transactionService from '../services/transaction.service';

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

  app.post('/transactions/receipt', async (req) => {
    const file = await req.file();
    if (!file) throw new BadRequestError('multipart image field is required');
    const image = await file.toBuffer();
    return transactionService.scanReceipt(req.accountId, image);
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

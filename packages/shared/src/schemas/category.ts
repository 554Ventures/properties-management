import { z } from 'zod';
import { TransactionTypeSchema } from '../enums';

export const CategorySchema = z.object({
  id: z.string(),
  accountId: z.string().nullable(), // null = system-seeded
  name: z.string(),
  type: TransactionTypeSchema,
  irsScheduleELine: z.string().nullable(), // e.g. "Line 14 – Repairs"
  isSystem: z.boolean(),
});

// GET /categories
export const CategoryListResponseSchema = z.array(CategorySchema);

// POST /categories
export const CreateCategoryInputSchema = z.object({
  name: z.string().min(1),
  type: TransactionTypeSchema,
  irsScheduleELine: z.string().optional(),
});

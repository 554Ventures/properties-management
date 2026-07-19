import { z } from 'zod';
import { FeedbackCategorySchema } from '../enums';

// A beta-feedback submission from the in-app "Send feedback" modal. Stored
// verbatim; the owner is notified by email (fire-and-forget, never blocks the
// write). userAgent is captured server-side from the request header — the
// client never sends it.
export const FeedbackSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  userId: z.string().nullable(), // null in demo mode
  category: FeedbackCategorySchema,
  message: z.string(),
  pagePath: z.string().nullable(), // route the client was on when the modal opened
  userAgent: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Feedback = z.infer<typeof FeedbackSchema>;

// POST /feedback
export const CreateFeedbackInputSchema = z.object({
  category: FeedbackCategorySchema,
  message: z.string().min(1).max(2000),
  pagePath: z.string().max(300).optional(),
});
export type CreateFeedbackInput = z.infer<typeof CreateFeedbackInputSchema>;

import { z } from 'zod';
import { GraceDaysBasisSchema } from '../enums';

export const AccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  timezone: z.string(),
  taxRatePct: z.number().int().min(0).max(100),
  taxYearStartMonth: z.number().int().min(1).max(12),
  graceDays: z.number().int().min(0),
  // How graceDays is measured — 'calendar' (default) or 'business' days.
  graceDaysBasis: GraceDaysBasisSchema,
  // Account-wide default late fee in cents (WS7); 0 = late fees disabled. A
  // lease may override this. Applying a fee is always an explicit human action.
  defaultLateFeeCents: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  // Data erasure (docs/SECURITY_PRIVACY_AUDIT.md §B2): set while the account
  // is in its post-request grace window, awaiting hard deletion.
  deletionRequestedAt: z.string().datetime().nullable(),
});

// GET /settings/account — the account is the settings object in v1.
export const AccountSettingsSchema = AccountSchema;

// PATCH /settings/account
export const UpdateAccountSettingsInputSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  timezone: z.string().min(1).optional(),
  taxRatePct: z.number().int().min(0).max(100).optional(),
  taxYearStartMonth: z.number().int().min(1).max(12).optional(),
  graceDays: z.number().int().min(0).optional(),
  graceDaysBasis: GraceDaysBasisSchema.optional(),
  defaultLateFeeCents: z.number().int().nonnegative().optional(),
});

// POST /settings/account/deletion — request account deletion; the account
// hard-deletes after ACCOUNT_DELETION_GRACE_DAYS unless cancelled first.
export const RequestAccountDeletionResponseSchema = z.object({
  deletionRequestedAt: z.string().datetime(),
  scheduledDeletionAt: z.string().datetime(),
});

import { z } from 'zod';

export const AccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  timezone: z.string(),
  taxRatePct: z.number().int().min(0).max(100),
  taxYearStartMonth: z.number().int().min(1).max(12),
  graceDays: z.number().int().min(0),
  createdAt: z.string().datetime(),
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
});

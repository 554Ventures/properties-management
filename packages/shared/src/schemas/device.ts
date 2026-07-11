import { z } from 'zod';
import { PushPlatformSchema } from '../enums';

// A registered push-notification device (Phase 2 iOS shell). One row per APNs
// device token; re-registering the same token bumps lastSeenAt.
export const PushDeviceSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  platform: PushPlatformSchema,
  token: z.string(),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});

// POST /devices
export const RegisterDeviceInputSchema = z.object({
  platform: PushPlatformSchema,
  token: z.string().min(1),
});

// GET /devices
export const PushDeviceListResponseSchema = z.array(PushDeviceSchema);

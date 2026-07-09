import { z } from 'zod';

// POST /settings/consent — records acceptance of the Privacy Policy + Terms
// of Service for the current Supabase identity (docs/SECURITY_PRIVACY_AUDIT.md
// §B5). policyVersion identifies *which* version was shown/accepted, since
// the documents change over time.
export const RecordConsentInputSchema = z.object({
  policyVersion: z.string().min(1),
});

// GET/POST /settings/consent response.
export const PolicyConsentStatusSchema = z.object({
  accepted: z.boolean(),
  acceptedAt: z.string().datetime().nullable(),
  policyVersion: z.string().nullable(),
});

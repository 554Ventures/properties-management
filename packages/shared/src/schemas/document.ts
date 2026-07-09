import { z } from 'zod';
import { DocumentEntityTypeSchema, DocumentTypeSchema } from '../enums';

// An uploaded file attached to exactly one entity (property/unit/tenant/lease/
// transaction). Display context is derived upward — e.g. a lease document also
// appears on the lease's tenants and property — never stored twice.
export const DocumentSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  entityType: DocumentEntityTypeSchema,
  entityId: z.string(),
  type: DocumentTypeSchema,
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  createdAt: z.string().datetime(),
});

// POST /documents — multipart: the file part plus these text fields.
export const CreateDocumentFieldsSchema = z.object({
  entityType: DocumentEntityTypeSchema,
  entityId: z.string().min(1),
  type: DocumentTypeSchema,
  name: z.string().min(1).max(200).optional(), // defaults to the uploaded filename
});

// PATCH /documents/:id
export const UpdateDocumentInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: DocumentTypeSchema.optional(),
});

// GET /documents — propertyId/tenantId filters include derived context (docs on
// the property's units/leases/transactions; docs on the tenant's leases).
// entityType+entityId is an exact match, no derivation.
export const DocumentListQuerySchema = z.object({
  entityType: DocumentEntityTypeSchema.optional(),
  entityId: z.string().optional(),
  propertyId: z.string().optional(),
  tenantId: z.string().optional(),
  type: DocumentTypeSchema.optional(),
  q: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

// List row carries server-resolved display fields so clients never N+1:
// entityLabel names the attached entity; propertyId/tenantId are the owning
// property / primary tenant (null when not applicable) for building links.
export const DocumentListRowSchema = DocumentSchema.extend({
  entityLabel: z.string(),
  propertyId: z.string().nullable(),
  tenantId: z.string().nullable(),
});

export const DocumentListResponseSchema = z.object({
  documents: z.array(DocumentListRowSchema),
  total: z.number().int(),
});

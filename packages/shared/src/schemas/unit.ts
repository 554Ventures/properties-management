import { z } from 'zod';

export const UnitSchema = z.object({
  id: z.string(),
  propertyId: z.string(),
  label: z.string(),
  bedrooms: z.number().int().nullable(),
  bathrooms: z.number().nullable(),
  marketRentCents: z.number().int().nullable(),
});

// POST /properties/:id/units (also nested inside CreatePropertyInput)
export const CreateUnitInputSchema = z.object({
  label: z.string().min(1),
  bedrooms: z.number().int().min(0).optional(),
  bathrooms: z.number().min(0).optional(),
  marketRentCents: z.number().int().min(0).optional(),
});

// PATCH /units/:id
export const UpdateUnitInputSchema = CreateUnitInputSchema.partial();

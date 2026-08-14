-- Data migration: seed the "Not Rental Income" system category.
--
-- Every seeded income category maps to "Line 3 – Rents received", so a tax
-- refund or an interest deposit had nowhere to land except Schedule E rental
-- income. This adds the one income category that maps off the form.
--
-- Why a migration and not just SEED_CATEGORIES: auth.service.ensureSystemCategories
-- short-circuits as soon as ANY system category exists, so an account created
-- before today never picks up newly seeded categories. This INSERT is the only
-- path onto an existing database (production is never demo-seeded).
--
-- Idempotent, and a no-op on dev/test where prisma/seed.ts wipes and recreates
-- the system categories from SEED_CATEGORIES anyway. The literal id is
-- deliberate: Category.id is a Prisma-side cuid() with no DB default, and a
-- fixed value keeps the insert re-runnable.
INSERT INTO "Category" ("id", "accountId", "name", "type", "irsScheduleELine", "isSystem")
SELECT
  'sys_cat_not_rental_income',
  NULL,
  'Not Rental Income',
  'income',
  'Not reported on Schedule E',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM "Category"
  WHERE "isSystem" = true
    AND "accountId" IS NULL
    AND "type" = 'income'
    AND "name" = 'Not Rental Income'
);

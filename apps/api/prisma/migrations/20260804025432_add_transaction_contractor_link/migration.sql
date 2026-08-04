-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "contractorId" TEXT;

-- CreateIndex
CREATE INDEX "Transaction_contractorId_idx" ON "Transaction"("contractorId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_contractorId_fkey" FOREIGN KEY ("contractorId") REFERENCES "Contractor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: adopt existing rows under the same vendor-name match the read
-- paths used until now (vendorKey = lower(trim(name)); ARCHITECTURE §4), so
-- derived contractor stats are unchanged by the FK switch. Ambiguity guard:
-- an account with several active contractors sharing one name key links
-- nothing for that key (mirrors the write-time rule in services/vendor.ts).
UPDATE "Transaction" t
SET "contractorId" = c.id
FROM "Contractor" c
WHERE c."accountId" = t."accountId"
  AND c."archivedAt" IS NULL
  AND t."vendor" IS NOT NULL
  AND lower(trim(t."vendor")) = lower(trim(c."name"))
  AND (
    SELECT count(*) FROM "Contractor" c2
    WHERE c2."accountId" = t."accountId"
      AND c2."archivedAt" IS NULL
      AND lower(trim(c2."name")) = lower(trim(c."name"))
  ) = 1;

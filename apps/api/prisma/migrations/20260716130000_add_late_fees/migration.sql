-- Late fees v1 (WS7): policy is configured (Account default + optional Lease
-- override); application is an explicit human action that stamps the charge's
-- lateFeeCents. All additive with safe defaults — the seed stays fee-free.

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "defaultLateFeeCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Lease" ADD COLUMN     "lateFeeCents" INTEGER;

-- AlterTable
ALTER TABLE "RentPayment" ADD COLUMN     "lateFeeCents" INTEGER NOT NULL DEFAULT 0;

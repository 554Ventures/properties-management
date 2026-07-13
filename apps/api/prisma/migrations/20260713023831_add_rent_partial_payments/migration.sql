-- AlterTable
ALTER TABLE "RentPayment" ADD COLUMN     "paidCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "RentPaymentDeposit" (
    "id" TEXT NOT NULL,
    "rentPaymentId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "tenantId" TEXT,
    "method" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentPaymentDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RentPaymentDeposit_transactionId_key" ON "RentPaymentDeposit"("transactionId");

-- CreateIndex
CREATE INDEX "RentPaymentDeposit_rentPaymentId_idx" ON "RentPaymentDeposit"("rentPaymentId");

-- AddForeignKey
ALTER TABLE "RentPaymentDeposit" ADD CONSTRAINT "RentPaymentDeposit_rentPaymentId_fkey" FOREIGN KEY ("rentPaymentId") REFERENCES "RentPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentPaymentDeposit" ADD CONSTRAINT "RentPaymentDeposit_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RentPaymentDeposit" ADD CONSTRAINT "RentPaymentDeposit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill (plan §B2): pre-partial rows were binary paid-in-full, so a paid
-- charge's running total IS its amount. Without this, collectedCents (now
-- summed from paidCents) would read 0 for every historical month. Legacy
-- single-payment links become deposits so the deposit ledger is the source of
-- truth for every paid charge, not only post-migration ones.
UPDATE "RentPayment" SET "paidCents" = "amountCents" WHERE "status" = 'paid';

INSERT INTO "RentPaymentDeposit" ("id", "rentPaymentId", "transactionId", "amountCents", "method", "paidAt")
SELECT 'rpd_' || "id", "id", "transactionId", "amountCents", "method", COALESCE("paidAt", CURRENT_TIMESTAMP)
FROM "RentPayment"
WHERE "status" = 'paid' AND "transactionId" IS NOT NULL;

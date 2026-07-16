-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "lastSyncError" TEXT,
ADD COLUMN     "lastSyncErrorAt" TIMESTAMP(3),
ADD COLUMN     "syncFailureCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BankSyncDiscrepancy" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "transactionId" TEXT,
    "externalId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "bankDataJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "BankSyncDiscrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankSyncDiscrepancy_accountId_status_idx" ON "BankSyncDiscrepancy"("accountId", "status");

-- AddForeignKey
ALTER TABLE "BankSyncDiscrepancy" ADD CONSTRAINT "BankSyncDiscrepancy_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankSyncDiscrepancy" ADD CONSTRAINT "BankSyncDiscrepancy_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Integration" ADD COLUMN "configJson" TEXT NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "externalId" TEXT;

-- CreateIndex
-- Multiple NULLs are distinct under a unique index, so existing manual/receipt
-- rows (externalId = null) are unaffected by this constraint.
CREATE UNIQUE INDEX "Transaction_accountId_externalId_key" ON "Transaction"("accountId", "externalId");

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "recurringTemplateId" TEXT;

-- CreateTable
CREATE TABLE "RecurringTemplate" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "vendor" TEXT,
    "propertyId" TEXT,
    "unitId" TEXT,
    "categoryId" TEXT,
    "type" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "cadence" TEXT NOT NULL,
    "anchorDate" TIMESTAMP(3) NOT NULL,
    "mortgageId" TEXT,
    "principalCents" INTEGER,
    "lastDraftedOccurrence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "RecurringTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringTemplate_accountId_archivedAt_idx" ON "RecurringTemplate"("accountId", "archivedAt");

-- CreateIndex
CREATE INDEX "Transaction_recurringTemplateId_idx" ON "Transaction"("recurringTemplateId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_recurringTemplateId_fkey" FOREIGN KEY ("recurringTemplateId") REFERENCES "RecurringTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringTemplate" ADD CONSTRAINT "RecurringTemplate_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

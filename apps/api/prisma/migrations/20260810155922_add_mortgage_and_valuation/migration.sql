-- CreateTable
CREATE TABLE "Mortgage" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "lender" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL,
    "balanceAsOfDate" TIMESTAMP(3) NOT NULL,
    "originalPrincipalCents" INTEGER,
    "startDate" TIMESTAMP(3),
    "interestRateMilliPct" INTEGER,
    "escrowNote" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Mortgage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyValuation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "valueCents" INTEGER NOT NULL,
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyValuation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Mortgage_accountId_idx" ON "Mortgage"("accountId");

-- CreateIndex
CREATE INDEX "Mortgage_accountId_propertyId_archivedAt_idx" ON "Mortgage"("accountId", "propertyId", "archivedAt");

-- CreateIndex
CREATE INDEX "PropertyValuation_accountId_propertyId_asOfDate_idx" ON "PropertyValuation"("accountId", "propertyId", "asOfDate");

-- AddForeignKey
ALTER TABLE "Mortgage" ADD CONSTRAINT "Mortgage_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyValuation" ADD CONSTRAINT "PropertyValuation_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

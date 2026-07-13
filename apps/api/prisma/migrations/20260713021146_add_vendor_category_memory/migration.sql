-- CreateTable
CREATE TABLE "VendorCategoryMemory" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "vendorKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.95,
    "hitCount" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorCategoryMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorCategoryMemory_accountId_idx" ON "VendorCategoryMemory"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorCategoryMemory_accountId_vendorKey_type_key" ON "VendorCategoryMemory"("accountId", "vendorKey", "type");

-- AddForeignKey
ALTER TABLE "VendorCategoryMemory" ADD CONSTRAINT "VendorCategoryMemory_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorCategoryMemory" ADD CONSTRAINT "VendorCategoryMemory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

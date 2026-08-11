-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "mortgageId" TEXT,
ADD COLUMN     "principalCents" INTEGER;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_mortgageId_fkey" FOREIGN KEY ("mortgageId") REFERENCES "Mortgage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

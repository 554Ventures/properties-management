-- AlterTable
ALTER TABLE "User" ADD COLUMN     "policyConsentAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "policyConsentVersion" TEXT;

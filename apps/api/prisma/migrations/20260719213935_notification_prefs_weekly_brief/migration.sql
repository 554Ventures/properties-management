-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "notificationPrefsJson" TEXT NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "PushDevice" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notificationPrefsJson" TEXT NOT NULL DEFAULT '{}';

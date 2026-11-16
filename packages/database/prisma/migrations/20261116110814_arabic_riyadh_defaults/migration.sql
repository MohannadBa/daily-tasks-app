-- AlterTable
ALTER TABLE "Company" ALTER COLUMN "timezone" SET DEFAULT 'Asia/Riyadh';

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "locale" SET DEFAULT 'ar';

-- Data: the platform runs in Riyadh time. Only companies still on the old implicit default are changed.
UPDATE "Company" SET "timezone" = 'Asia/Riyadh' WHERE "timezone" = 'UTC';

/*
  Warnings:

  - You are about to drop the `DeviceInstallation` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PushTicket` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('IOS', 'ANDROID', 'DESKTOP', 'OTHER');

-- CreateEnum
CREATE TYPE "PushDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'PUSH_TEST';

-- DropForeignKey
ALTER TABLE "DeviceInstallation" DROP CONSTRAINT "DeviceInstallation_userId_fkey";

-- DropForeignKey
ALTER TABLE "PushTicket" DROP CONSTRAINT "PushTicket_deviceInstallationId_fkey";

-- DropTable
DROP TABLE "DeviceInstallation";

-- DropTable
DROP TABLE "PushTicket";

-- DropEnum
DROP TYPE "DevicePlatform";

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "platform" "PushPlatform" NOT NULL DEFAULT 'OTHER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" TIMESTAMPTZ(3),
    "deactivatedAt" TIMESTAMPTZ(3),
    "deactivationReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDelivery" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "status" "PushDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "statusCode" INTEGER,
    "lastError" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PushDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_isActive_idx" ON "PushSubscription"("userId", "isActive");

-- CreateIndex
CREATE INDEX "PushDelivery_subscriptionId_createdAt_idx" ON "PushDelivery"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "PushDelivery_status_createdAt_idx" ON "PushDelivery"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushDelivery_notificationId_subscriptionId_key" ON "PushDelivery"("notificationId", "subscriptionId");

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDelivery" ADD CONSTRAINT "PushDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDelivery" ADD CONSTRAINT "PushDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "PushSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written constraints (Prisma cannot express these).
ALTER TABLE "PushSubscription"
  ADD CONSTRAINT "PushSubscription_endpoint_https_chk" CHECK ("endpoint" ~ '^https?://' AND length("endpoint") <= 2048),
  ADD CONSTRAINT "PushSubscription_keys_chk" CHECK (length("p256dh") BETWEEN 80 AND 100 AND length("auth") BETWEEN 16 AND 32),
  ADD CONSTRAINT "PushSubscription_failureCount_chk" CHECK ("failureCount" >= 0),
  -- An inactive subscription always records when it was deactivated.
  ADD CONSTRAINT "PushSubscription_active_chk" CHECK ("isActive" OR "deactivatedAt" IS NOT NULL);

ALTER TABLE "PushDelivery"
  ADD CONSTRAINT "PushDelivery_attempts_chk" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "PushDelivery_sent_chk" CHECK (("status" = 'SENT') = ("sentAt" IS NOT NULL));

-- AlterTable
ALTER TABLE "AlertEvent" ADD COLUMN "readAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "AlertEvent_userId_readAt_idx" ON "AlertEvent"("userId", "readAt");

-- Add origin tagging to Orders and Trades so the activity feed can show
-- WHO placed each entry (web · chat · telegram · agent · DCA · scheduled · fast-lane · API).
-- Free-form TEXT (not enum) so we can extend without a follow-up migration.

ALTER TABLE "Order" ADD COLUMN "source" TEXT;
ALTER TABLE "Trade" ADD COLUMN "source" TEXT;

-- New index on Order(userId, createdAt) for the activity feed sort.
CREATE INDEX "Order_userId_createdAt_idx" ON "Order" ("userId", "createdAt");

-- Add trace_id to transactional tables so every HTTP entry → swap → trade →
-- audit → alert hop can be correlated via a single identifier.

ALTER TABLE "Trade" ADD COLUMN "traceId" TEXT;
ALTER TABLE "Order" ADD COLUMN "traceId" TEXT;
ALTER TABLE "AlertEvent" ADD COLUMN "traceId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "traceId" TEXT;

-- Hot lookup paths: dashboards & support tools fetch by traceId.
CREATE INDEX "Trade_traceId_idx" ON "Trade"("traceId");
CREATE INDEX "Order_traceId_idx" ON "Order"("traceId");

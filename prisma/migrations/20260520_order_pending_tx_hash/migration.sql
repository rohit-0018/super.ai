-- Add pendingTxHash to Order for crash-recovery tx confirmation polling
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "pendingTxHash" TEXT;
CREATE INDEX IF NOT EXISTS "Order_status_pendingTxHash_idx" ON "Order"("status", "pendingTxHash");

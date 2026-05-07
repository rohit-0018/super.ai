-- Exit engine fields added to Trade model without a migration file.
-- All ADD COLUMN statements use IF NOT EXISTS so this is safe to re-run.

ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "entryMcapUsd"          DOUBLE PRECISION;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "highestMcapSeen"       DOUBLE PRECISION;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "lastSignificantMoveAt" TIMESTAMP(3);
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "tiersExecuted"         JSONB;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "exitReason"            TEXT;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "exitAt"                TIMESTAMP(3);
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "realizedPnl"           DOUBLE PRECISION;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "holdDurationSec"       INTEGER;

-- Index added alongside these fields for exit engine open-trade scans
CREATE INDEX IF NOT EXISTS "Trade_exitAt_idx" ON "Trade"("exitAt");

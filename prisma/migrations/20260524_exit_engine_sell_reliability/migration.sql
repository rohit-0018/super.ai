-- Exit engine sell-reliability fields.
-- All statements idempotent / safe to re-run (matches repo migration style).

-- Running sum of USD received across all (partial) sells of a position;
-- realizedPnl at full exit = realizedProceedsUsd - entry cost.
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "realizedProceedsUsd" DOUBLE PRECISION;

-- Consecutive failed sell attempts for the currently pending exit action.
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "sellAttempts" INTEGER NOT NULL DEFAULT 0;

-- Last sell failure reason (diagnostics / alerting).
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "lastSellError" TEXT;

-- Retries exhausted — position needs manual intervention, auto-retry paused.
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "sellStuck" BOOLEAN NOT NULL DEFAULT false;

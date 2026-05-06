-- Snapshot of token economics at fill time so SnipeTrade rows carry frozen
-- historical context for accurate "mcap at buy", "price at buy", and realized
-- P&L rendering even after the live token price drifts.
--
-- Re-homed from 20260429_snipe_buy_snapshot so it runs AFTER 20260429_snipe_tables
-- (alphabetical: `_snipe_buy_…` < `_snipe_tables`, so the original path executed
-- before the table existed). Original path kept as a no-op stub.

ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "priceAtBuyUsd" DOUBLE PRECISION;
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "mcapAtBuyUsd" DOUBLE PRECISION;
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "liquidityAtBuyUsd" DOUBLE PRECISION;
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "solPriceAtBuyUsd" DOUBLE PRECISION;

ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "proceedsSolAtSell" DOUBLE PRECISION;
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "proceedsUsdAtSell" DOUBLE PRECISION;
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "pnlUsdRealized" DOUBLE PRECISION;
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "pnlPctRealized" DOUBLE PRECISION;

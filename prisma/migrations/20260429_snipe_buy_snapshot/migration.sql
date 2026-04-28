-- Snapshot of token economics at fill time so SnipeTrade rows carry frozen
-- historical context for accurate "mcap at buy", "price at buy", and realized
-- P&L rendering even after the live token price drifts.

ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "priceAtBuyUsd" DOUBLE PRECISION;
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "mcapAtBuyUsd" DOUBLE PRECISION;
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "liquidityAtBuyUsd" DOUBLE PRECISION;
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "solPriceAtBuyUsd" DOUBLE PRECISION;

ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "proceedsSolAtSell" DOUBLE PRECISION;
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "proceedsUsdAtSell" DOUBLE PRECISION;
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "pnlUsdRealized" DOUBLE PRECISION;
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "pnlPctRealized" DOUBLE PRECISION;

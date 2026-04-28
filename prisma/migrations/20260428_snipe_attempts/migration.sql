-- Track how many broadcast attempts were made for each snipe (including slippage retries)
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 1;

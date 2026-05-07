-- Track how many broadcast attempts were made for each snipe (including slippage retries).
-- Re-homed from 20260428_snipe_attempts so it runs AFTER 20260429_snipe_tables (which
-- creates SnipeTrade). The original 20260428 path is kept as a no-op stub for prisma
-- migration tracking compatibility.
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 1;

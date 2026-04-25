-- Add error message column to SnipeTrade for storing failure reasons
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "errorMsg" TEXT;

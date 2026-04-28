-- Add isImported and backedUpAt to Wallet
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "isImported" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "backedUpAt" TIMESTAMP(3);

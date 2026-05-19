-- Add multisig support fields to Wallet model
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "multisigAddress" TEXT;
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "multisigThreshold" INTEGER;
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "multisigMembers" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "keyStorageKind" TEXT NOT NULL DEFAULT 'KMS';

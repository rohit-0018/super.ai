-- Snipe subsystem tables: SnipeConfig, TgUserSession, SnipeTrade, SnipeGroupOverride.
-- All statements use IF NOT EXISTS / exception handlers so the migration
-- is safe to re-run after a partial failure.

DO $$ BEGIN
  CREATE TYPE "SellMode" AS ENUM ('TRIGGER', 'INTELLIGENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END; $$;

CREATE TABLE IF NOT EXISTS "SnipeConfig" (
  "id"               TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "enabled"          BOOLEAN NOT NULL DEFAULT false,
  "chain"            "Chain" NOT NULL DEFAULT 'SOLANA',
  "walletId"         TEXT NOT NULL,
  "buyAmountRaw"     TEXT NOT NULL DEFAULT '100000000',
  "maxSlippageBps"   INTEGER NOT NULL DEFAULT 5000,
  "groupIds"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "skipSafety"       BOOLEAN NOT NULL DEFAULT true,
  "dedupeWindowMs"   INTEGER NOT NULL DEFAULT 30000,
  "minLiqUsd"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "notifyOnBuy"      BOOLEAN NOT NULL DEFAULT true,
  "matchPattern"     TEXT,
  "sessionExpiresAt" TIMESTAMP(3),
  "sellEnabled"      BOOLEAN NOT NULL DEFAULT true,
  "sellMode"         "SellMode" NOT NULL DEFAULT 'TRIGGER',
  "takeProfitPct"    DOUBLE PRECISION,
  "stopLossPct"      DOUBLE PRECISION,
  "trailingStopPct"  DOUBLE PRECISION,
  "exitAfterMs"      INTEGER,
  "partialExitPct"   DOUBLE PRECISION,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SnipeConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SnipeConfig_userId_key" ON "SnipeConfig"("userId");
CREATE INDEX        IF NOT EXISTS "SnipeConfig_enabled_idx" ON "SnipeConfig"("enabled");
DO $$ BEGIN
  ALTER TABLE "SnipeConfig" ADD CONSTRAINT "SnipeConfig_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END; $$;

CREATE TABLE IF NOT EXISTS "TgUserSession" (
  "id"               TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "phoneNumber"      TEXT NOT NULL,
  "encryptedSession" TEXT NOT NULL,
  "encryptedDek"     TEXT NOT NULL,
  "isActive"         BOOLEAN NOT NULL DEFAULT true,
  "lastConnectedAt"  TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TgUserSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TgUserSession_userId_key" ON "TgUserSession"("userId");
DO $$ BEGIN
  ALTER TABLE "TgUserSession" ADD CONSTRAINT "TgUserSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END; $$;

CREATE TABLE IF NOT EXISTS "SnipeTrade" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "chain"         "Chain" NOT NULL,
  "mint"          TEXT NOT NULL,
  "amountRaw"     TEXT NOT NULL,
  "txHash"        TEXT,
  "outAmount"     TEXT,
  "groupId"       TEXT NOT NULL,
  "sourceMsg"     TEXT,
  "status"        TEXT NOT NULL DEFAULT 'broadcast',
  "errorMsg"      TEXT,
  "sellTxHash"    TEXT,
  "sellStatus"    TEXT,
  "sellReason"    TEXT,
  "peakPriceMul"  DOUBLE PRECISION,
  "sellCheckedAt" TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SnipeTrade_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SnipeTrade_userId_createdAt_idx" ON "SnipeTrade"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "SnipeTrade_mint_createdAt_idx"   ON "SnipeTrade"("mint", "createdAt");
DO $$ BEGIN
  ALTER TABLE "SnipeTrade" ADD CONSTRAINT "SnipeTrade_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END; $$;

CREATE TABLE IF NOT EXISTS "SnipeGroupOverride" (
  "id"              TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "groupId"         TEXT NOT NULL,
  "groupTitle"      TEXT NOT NULL DEFAULT '',
  "enabled"         BOOLEAN NOT NULL DEFAULT true,
  "buyAmountRaw"    TEXT,
  "maxSlippageBps"  INTEGER,
  "sellMode"        "SellMode",
  "takeProfitPct"   DOUBLE PRECISION,
  "stopLossPct"     DOUBLE PRECISION,
  "trailingStopPct" DOUBLE PRECISION,
  "exitAfterMs"     INTEGER,
  "matchPattern"    TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SnipeGroupOverride_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SnipeGroupOverride_userId_groupId_key" ON "SnipeGroupOverride"("userId", "groupId");
CREATE INDEX        IF NOT EXISTS "SnipeGroupOverride_userId_idx"          ON "SnipeGroupOverride"("userId");
DO $$ BEGIN
  ALTER TABLE "SnipeGroupOverride" ADD CONSTRAINT "SnipeGroupOverride_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END; $$;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  bootstrap.sql — fail-safe schema reconciliation                         ║
-- ║                                                                          ║
-- ║  Runs on every Render deploy BEFORE `prisma migrate deploy` to guarantee ║
-- ║  the live database has every column/table the codebase reads from, even  ║
-- ║  if Prisma's _prisma_migrations tracking is stuck or out of sync.        ║
-- ║                                                                          ║
-- ║  Every statement is idempotent (IF NOT EXISTS). Safe to re-run forever.  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── Intel Track Record ───────────────────────────────────────────────────────
-- Frozen snapshots + price ticks for the "we called this at $X, now $Y" surface.
CREATE TABLE IF NOT EXISTS "IntelSnapshot" (
    "id"                    TEXT NOT NULL,
    "userId"                TEXT,
    "chain"                 "Chain" NOT NULL,
    "address"               TEXT NOT NULL,
    "symbol"                TEXT,
    "name"                  TEXT,
    "capturedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source"                TEXT NOT NULL,
    "profileKey"            TEXT,
    "priceUsdAtCapture"     DOUBLE PRECISION NOT NULL,
    "marketCapUsdAtCapture" DOUBLE PRECISION,
    "liquidityUsdAtCapture" DOUBLE PRECISION,
    "volume24hAtCapture"    DOUBLE PRECISION,
    "reportJson"            JSONB NOT NULL,
    "aiScore"               INTEGER,
    "aiVerdict"             TEXT,
    "aiSummary"             TEXT,
    "killTriggered"         BOOLEAN NOT NULL DEFAULT false,
    "lastRescannedAt"       TIMESTAMP(3),
    "currentPriceUsd"       DOUBLE PRECISION,
    "currentMcapUsd"        DOUBLE PRECISION,
    "currentLiquidity"      DOUBLE PRECISION,
    "pumpedHigh"            DOUBLE PRECISION,
    "pumpedHighAt"          TIMESTAMP(3),
    "drawdownLow"           DOUBLE PRECISION,
    "drawdownLowAt"         TIMESTAMP(3),
    "rescanCount"           INTEGER NOT NULL DEFAULT 0,
    "reappearedAt"          TIMESTAMP(3),
    "reappearedSource"      TEXT,
    "status"                TEXT NOT NULL DEFAULT 'active',
    "sparkline"             JSONB,
    CONSTRAINT "IntelSnapshot_pkey" PRIMARY KEY ("id")
);
DO $$ BEGIN
  CREATE UNIQUE INDEX "IntelSnapshot_chain_address_key" ON "IntelSnapshot"("chain", "address");
EXCEPTION WHEN duplicate_table THEN NULL;
END; $$;
DO $$ BEGIN
  CREATE INDEX "IntelSnapshot_status_capturedAt_idx" ON "IntelSnapshot"("status", "capturedAt");
EXCEPTION WHEN duplicate_table THEN NULL;
END; $$;
DO $$ BEGIN
  CREATE INDEX "IntelSnapshot_pumpedHigh_idx" ON "IntelSnapshot"("pumpedHigh");
EXCEPTION WHEN duplicate_table THEN NULL;
END; $$;
DO $$ BEGIN
  CREATE INDEX "IntelSnapshot_source_capturedAt_idx" ON "IntelSnapshot"("source", "capturedAt");
EXCEPTION WHEN duplicate_table THEN NULL;
END; $$;
DO $$ BEGIN
  ALTER TABLE "IntelSnapshot" ADD CONSTRAINT "IntelSnapshot_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END; $$;

CREATE TABLE IF NOT EXISTS "IntelRescan" (
    "id"            TEXT NOT NULL,
    "snapshotId"    TEXT NOT NULL,
    "ts"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priceUsd"      DOUBLE PRECISION NOT NULL,
    "marketCapUsd"  DOUBLE PRECISION,
    "liquidityUsd"  DOUBLE PRECISION,
    "volume24hUsd"  DOUBLE PRECISION,
    "aiVerdict"     TEXT,
    "aiScore"       INTEGER,
    CONSTRAINT "IntelRescan_pkey" PRIMARY KEY ("id")
);
DO $$ BEGIN
  CREATE INDEX "IntelRescan_snapshotId_ts_idx" ON "IntelRescan"("snapshotId", "ts");
EXCEPTION WHEN duplicate_table THEN NULL;
END; $$;
DO $$ BEGIN
  ALTER TABLE "IntelRescan" ADD CONSTRAINT "IntelRescan_snapshotId_fkey"
    FOREIGN KEY ("snapshotId") REFERENCES "IntelSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END; $$;

-- ── ProviderConfig (whole table) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ProviderConfig" (
    "id"            TEXT NOT NULL,
    "key"           TEXT NOT NULL,
    "displayName"   TEXT NOT NULL,
    "dataGroup"     TEXT NOT NULL,
    "priority"      INTEGER NOT NULL DEFAULT 100,
    "reqsPerWindow" INTEGER NOT NULL DEFAULT 60,
    "windowSec"     INTEGER NOT NULL DEFAULT 60,
    "cooldownSec"   INTEGER NOT NULL DEFAULT 120,
    "enabled"       BOOLEAN NOT NULL DEFAULT true,
    "requiresKey"   TEXT,
    "baseUrl"       TEXT,
    "notes"         TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProviderConfig_key_key" ON "ProviderConfig"("key");
CREATE INDEX        IF NOT EXISTS "ProviderConfig_dataGroup_priority_idx" ON "ProviderConfig"("dataGroup", "priority");

-- ── SnipeTrade missing columns ───────────────────────────────────────────────
-- 20260429_snipe_tables is in render-start.sh's `migrate resolve --rolled-back`
-- list, so on databases where the table predates it the CREATE TABLE is skipped
-- and these two columns never land. SnipeSellService.findMany() then throws on
-- every position-check tick. Both are nullable in schema.prisma, so a plain
-- idempotent ADD COLUMN reconciles without touching existing rows.
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "sellAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "walletId"     TEXT;
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "sellPhase"    TEXT;

-- ── Trade exit-engine sell-reliability columns ───────────────────────────────
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "realizedProceedsUsd" DOUBLE PRECISION;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "sellAttempts"        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "lastSellError"       TEXT;
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "sellStuck"           BOOLEAN NOT NULL DEFAULT false;

-- ── User leaderboard privacy controls ────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "leaderboardOptIn"  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "leaderboardHandle" TEXT;
DO $$ BEGIN
  CREATE UNIQUE INDEX "User_leaderboardHandle_key" ON "User"("leaderboardHandle");
EXCEPTION WHEN duplicate_table THEN NULL;
END; $$;

-- ── TokenIntel intelligence-layer columns ────────────────────────────────────
ALTER TABLE "TokenIntel" ADD COLUMN IF NOT EXISTS "aiScore"        INTEGER;
ALTER TABLE "TokenIntel" ADD COLUMN IF NOT EXISTS "aiVerdict"      TEXT;
ALTER TABLE "TokenIntel" ADD COLUMN IF NOT EXISTS "aiSummary"      TEXT;
ALTER TABLE "TokenIntel" ADD COLUMN IF NOT EXISTS "aiReasoning"    JSONB;
ALTER TABLE "TokenIntel" ADD COLUMN IF NOT EXISTS "killTriggered"  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TokenIntel" ADD COLUMN IF NOT EXISTS "killReason"     TEXT;
ALTER TABLE "TokenIntel" ADD COLUMN IF NOT EXISTS "holderMetrics"  JSONB;
ALTER TABLE "TokenIntel" ADD COLUMN IF NOT EXISTS "socialData"     JSONB;
ALTER TABLE "TokenIntel" ADD COLUMN IF NOT EXISTS "smartMoneyData" JSONB;
ALTER TABLE "TokenIntel" ADD COLUMN IF NOT EXISTS "fullReport"     JSONB;
ALTER TABLE "TokenIntel" ADD COLUMN IF NOT EXISTS "aiAnalyzedAt"   TIMESTAMP(3);

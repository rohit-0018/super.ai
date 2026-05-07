-- Catch-up migration: new tables and columns added to schema.prisma without migration files.
-- All statements are idempotent / safe to re-run.

-- ── User: leaderboard opt-in ──────────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "leaderboardOptIn"  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "leaderboardHandle" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "User_leaderboardHandle_key" ON "User"("leaderboardHandle");

-- ── IntelSnapshot ─────────────────────────────────────────────────────────────
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'IntelSnapshot_userId_fkey') THEN
    ALTER TABLE "IntelSnapshot" ADD CONSTRAINT "IntelSnapshot_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "IntelSnapshot_chain_address_key" ON "IntelSnapshot"("chain", "address");
CREATE INDEX IF NOT EXISTS "IntelSnapshot_status_capturedAt_idx"    ON "IntelSnapshot"("status", "capturedAt");
CREATE INDEX IF NOT EXISTS "IntelSnapshot_pumpedHigh_idx"           ON "IntelSnapshot"("pumpedHigh");
CREATE INDEX IF NOT EXISTS "IntelSnapshot_source_capturedAt_idx"    ON "IntelSnapshot"("source", "capturedAt");

-- ── IntelRescan ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "IntelRescan" (
  "id"           TEXT NOT NULL,
  "snapshotId"   TEXT NOT NULL,
  "ts"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "priceUsd"     DOUBLE PRECISION NOT NULL,
  "marketCapUsd" DOUBLE PRECISION,
  "liquidityUsd" DOUBLE PRECISION,
  "volume24hUsd" DOUBLE PRECISION,
  "aiVerdict"    TEXT,
  "aiScore"      INTEGER,
  CONSTRAINT "IntelRescan_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'IntelRescan_snapshotId_fkey') THEN
    ALTER TABLE "IntelRescan" ADD CONSTRAINT "IntelRescan_snapshotId_fkey"
      FOREIGN KEY ("snapshotId") REFERENCES "IntelSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "IntelRescan_snapshotId_ts_idx" ON "IntelRescan"("snapshotId", "ts");

-- ── VerdictHistory ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "VerdictHistory" (
  "id"             TEXT NOT NULL,
  "address"        TEXT NOT NULL,
  "chain"          "Chain" NOT NULL DEFAULT 'SOLANA',
  "symbol"         TEXT,
  "name"           TEXT,
  "analyzedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "aiScore"        INTEGER NOT NULL,
  "aiVerdict"      TEXT NOT NULL,
  "priceUsd"       DOUBLE PRECISION NOT NULL,
  "marketCapUsd"   DOUBLE PRECISION,
  "t1Pct"          DOUBLE PRECISION,
  "t2Pct"          DOUBLE PRECISION,
  "stopLossPct"    DOUBLE PRECISION,
  "riskReward"     DOUBLE PRECISION,
  "aiSummary"      TEXT,
  "bullishSignals" JSONB NOT NULL DEFAULT '[]',
  "riskFactors"    JSONB NOT NULL DEFAULT '[]',
  "source"         TEXT NOT NULL DEFAULT 'scanner_auto',
  "profileKey"     TEXT,
  "latencyMs"      INTEGER,
  CONSTRAINT "VerdictHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VerdictHistory_address_analyzedAt_idx" ON "VerdictHistory"("address", "analyzedAt");
CREATE INDEX IF NOT EXISTS "VerdictHistory_aiScore_analyzedAt_idx"  ON "VerdictHistory"("aiScore", "analyzedAt");
CREATE INDEX IF NOT EXISTS "VerdictHistory_analyzedAt_idx"          ON "VerdictHistory"("analyzedAt");

-- ── SnipeConfig: drop default on groupIds (Prisma no longer sets one) ─────────
ALTER TABLE "SnipeConfig" ALTER COLUMN "groupIds" DROP DEFAULT;

-- ── TradeEpisode: drop pgvector embedding index (managed separately) ──────────
DROP INDEX IF EXISTS "TradeEpisode_embedding_hnsw_idx";

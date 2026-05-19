-- Auto-trade engine tables: PaperPortfolio, PaperPosition, PaperTrade, PaperExitReason enum.
-- All statements are idempotent / safe to re-run.

-- ── PaperExitReason enum ──────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "PaperExitReason" AS ENUM ('TP1','TP2','STOP_LOSS','MAX_HOLD','MANUAL','RUG');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── PaperPortfolio ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PaperPortfolio" (
  "userId"              TEXT          NOT NULL,
  "startingBalanceUsd"  DOUBLE PRECISION NOT NULL DEFAULT 100000,
  "currentBalanceUsd"   DOUBLE PRECISION NOT NULL DEFAULT 100000,
  "realizedPnlUsd"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalTrades"         INTEGER       NOT NULL DEFAULT 0,
  "winCount"            INTEGER       NOT NULL DEFAULT 0,
  "lossCount"           INTEGER       NOT NULL DEFAULT 0,
  "autoEnabled"         BOOLEAN       NOT NULL DEFAULT false,
  "autoProfile"         TEXT          NOT NULL DEFAULT 'meme_hunter',
  "autoMinScore"        INTEGER       NOT NULL DEFAULT 70,
  "positionSizeUsd"     DOUBLE PRECISION NOT NULL DEFAULT 200,
  "maxConcurrent"       INTEGER       NOT NULL DEFAULT 10,
  "cooldownMinutes"     INTEGER       NOT NULL DEFAULT 15,
  "takeProfit1Pct"      DOUBLE PRECISION,
  "takeProfit2Pct"      DOUBLE PRECISION,
  "stopLossPct"         DOUBLE PRECISION,
  "maxHoldMinutes"      INTEGER,
  "resetAt"             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastTradeAt"         TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "PaperPortfolio_pkey" PRIMARY KEY ("userId")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaperPortfolio_userId_fkey') THEN
    ALTER TABLE "PaperPortfolio" ADD CONSTRAINT "PaperPortfolio_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── PaperPosition ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PaperPosition" (
  "id"                  TEXT          NOT NULL,
  "userId"              TEXT          NOT NULL,
  "tokenAddress"        TEXT          NOT NULL,
  "symbol"              TEXT,
  "name"                TEXT,
  "chain"               "Chain"       NOT NULL DEFAULT 'SOLANA',
  "profileKey"          TEXT          NOT NULL DEFAULT 'meme_hunter',
  "source"              TEXT          NOT NULL DEFAULT 'auto_picker',
  "openedAt"            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "entryPriceUsd"       DOUBLE PRECISION NOT NULL,
  "sizeUsd"             DOUBLE PRECISION NOT NULL,
  "tokenAmount"         DOUBLE PRECISION NOT NULL,
  "takeProfit1PriceUsd" DOUBLE PRECISION NOT NULL,
  "takeProfit2PriceUsd" DOUBLE PRECISION NOT NULL,
  "stopLossPriceUsd"    DOUBLE PRECISION NOT NULL,
  "maxHoldMs"           INTEGER       NOT NULL DEFAULT 14400000,
  "currentPriceUsd"     DOUBLE PRECISION NOT NULL,
  "unrealizedPnlUsd"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "unrealizedPnlPct"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "scoreAtEntry"        INTEGER       NOT NULL,
  "verdictAtEntry"      TEXT          NOT NULL,
  "scoreBreakdownJson"  JSONB,
  "updatedAt"           TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "PaperPosition_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaperPosition_userId_fkey') THEN
    ALTER TABLE "PaperPosition" ADD CONSTRAINT "PaperPosition_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "PaperPosition_userId_tokenAddress_key" ON "PaperPosition"("userId", "tokenAddress");
CREATE INDEX        IF NOT EXISTS "PaperPosition_userId_openedAt_idx"     ON "PaperPosition"("userId", "openedAt");

-- ── PaperTrade ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PaperTrade" (
  "id"                  TEXT             NOT NULL,
  "userId"              TEXT             NOT NULL,
  "tokenAddress"        TEXT             NOT NULL,
  "symbol"              TEXT,
  "name"                TEXT,
  "chain"               "Chain"          NOT NULL DEFAULT 'SOLANA',
  "profileKey"          TEXT             NOT NULL,
  "source"              TEXT             NOT NULL,
  "openedAt"            TIMESTAMP(3)     NOT NULL,
  "closedAt"            TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "holdMs"              INTEGER          NOT NULL,
  "entryPriceUsd"       DOUBLE PRECISION NOT NULL,
  "exitPriceUsd"        DOUBLE PRECISION NOT NULL,
  "sizeUsd"             DOUBLE PRECISION NOT NULL,
  "tokenAmount"         DOUBLE PRECISION NOT NULL,
  "pnlUsd"              DOUBLE PRECISION NOT NULL,
  "pnlPct"              DOUBLE PRECISION NOT NULL,
  "exitReason"          "PaperExitReason" NOT NULL,
  "scoreAtEntry"        INTEGER          NOT NULL,
  "verdictAtEntry"      TEXT             NOT NULL,
  "scoreBreakdownJson"  JSONB,
  CONSTRAINT "PaperTrade_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaperTrade_userId_fkey') THEN
    ALTER TABLE "PaperTrade" ADD CONSTRAINT "PaperTrade_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "PaperTrade_userId_closedAt_idx"    ON "PaperTrade"("userId", "closedAt");
CREATE INDEX IF NOT EXISTS "PaperTrade_userId_exitReason_idx"  ON "PaperTrade"("userId", "exitReason");

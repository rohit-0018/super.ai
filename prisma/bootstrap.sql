-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  bootstrap.sql — fail-safe schema reconciliation                         ║
-- ║                                                                          ║
-- ║  Runs on every Render deploy BEFORE `prisma migrate deploy` to guarantee ║
-- ║  the live database has every column/table the codebase reads from, even  ║
-- ║  if Prisma's _prisma_migrations tracking is stuck or out of sync.        ║
-- ║                                                                          ║
-- ║  Every statement is idempotent (IF NOT EXISTS). Safe to re-run forever.  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

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
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "sellAttempts" INTEGER NOT NULL DEFAULT 0;

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

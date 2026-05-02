-- Schema drift catch-up: columns added to schema.prisma without migrations.
-- All ADD COLUMN statements use IF NOT EXISTS so this is idempotent.

-- ── SnipeTrade ────────────────────────────────────────────────────────────────
ALTER TABLE "SnipeTrade" ADD COLUMN IF NOT EXISTS "sellAttempts" INTEGER NOT NULL DEFAULT 0;

-- ── TokenIntel — token intelligence layer ─────────────────────────────────────
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

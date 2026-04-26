-- L2: episodic memory with pgvector. One row per agent decision with a
-- 1536-d embedding for RAG-style retrieval of "similar past situations".
-- All statements use IF NOT EXISTS / exception handlers so the migration
-- is safe to re-run after a partial failure.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "TradeEpisode" (
  "id"              TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "tradeId"         TEXT,
  "chain"           "Chain" NOT NULL,
  "token"           TEXT NOT NULL,
  "side"            TEXT NOT NULL,
  "kind"            TEXT NOT NULL,
  "decisionContext" JSONB NOT NULL,
  "rationale"       TEXT NOT NULL,
  "outcome1h"       JSONB,
  "outcome24h"      JSONB,
  "embedding"       vector(1536),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TradeEpisode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TradeEpisode_tradeId_key"           ON "TradeEpisode"("tradeId");
CREATE INDEX        IF NOT EXISTS "TradeEpisode_userId_createdAt_idx"   ON "TradeEpisode"("userId", "createdAt");
CREATE INDEX        IF NOT EXISTS "TradeEpisode_userId_chain_token_idx" ON "TradeEpisode"("userId", "chain", "token");

-- HNSW index wrapped so the migration doesn't fail if pgvector < 0.5.0
-- or the index was already created in a previous partial run.
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "TradeEpisode_embedding_hnsw_idx"
    ON "TradeEpisode"
    USING hnsw ("embedding" vector_cosine_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'HNSW index skipped: %', SQLERRM;
END;
$$;

DO $$ BEGIN
  ALTER TABLE "TradeEpisode" ADD CONSTRAINT "TradeEpisode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END; $$;

DO $$ BEGIN
  ALTER TABLE "TradeEpisode" ADD CONSTRAINT "TradeEpisode_tradeId_fkey"
    FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END; $$;

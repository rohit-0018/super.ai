-- L2: episodic memory with pgvector. One row per agent decision with a
-- 1536-d embedding for RAG-style retrieval of "similar past situations".
-- Requires pgvector extension (available by default on Render managed
-- Postgres plans that enable it; run CREATE EXTENSION manually if denied).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "TradeEpisode" (
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

CREATE UNIQUE INDEX "TradeEpisode_tradeId_key"          ON "TradeEpisode"("tradeId");
CREATE INDEX        "TradeEpisode_userId_createdAt_idx"  ON "TradeEpisode"("userId", "createdAt");
CREATE INDEX        "TradeEpisode_userId_chain_token_idx" ON "TradeEpisode"("userId", "chain", "token");

-- HNSW cosine index. Rebuild to IVFFlat if row counts pass ~1M.
CREATE INDEX "TradeEpisode_embedding_hnsw_idx"
  ON "TradeEpisode"
  USING hnsw ("embedding" vector_cosine_ops);

ALTER TABLE "TradeEpisode" ADD CONSTRAINT "TradeEpisode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TradeEpisode" ADD CONSTRAINT "TradeEpisode_tradeId_fkey"
  FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropIndex (IF EXISTS: index is created in a later migration; may not exist on a fresh DB)
DROP INDEX IF EXISTS "TradeEpisode_embedding_hnsw_idx";

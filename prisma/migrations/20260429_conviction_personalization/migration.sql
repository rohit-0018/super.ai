-- L5: per-user ConvictionEngine weight personalization.
-- Adds UserConvictionWeights (1:1 user) + ConvictionWeightsHistory audit +
-- Trade.convictionBreakdown JSON snapshot.

CREATE TABLE "UserConvictionWeights" (
  "userId"         TEXT NOT NULL,
  "security"       DOUBLE PRECISION NOT NULL DEFAULT 0.30,
  "holders"        DOUBLE PRECISION NOT NULL DEFAULT 0.20,
  "liquidity"      DOUBLE PRECISION NOT NULL DEFAULT 0.15,
  "sentiment"      DOUBLE PRECISION NOT NULL DEFAULT 0.20,
  "momentum"       DOUBLE PRECISION NOT NULL DEFAULT 0.15,
  "version"        INTEGER NOT NULL DEFAULT 1,
  "sampleCount"    INTEGER NOT NULL DEFAULT 0,
  "manualOverride" BOOLEAN NOT NULL DEFAULT false,
  "learnedAt"      TIMESTAMP(3),
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserConvictionWeights_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "ConvictionWeightsHistory" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "version"     INTEGER NOT NULL,
  "security"    DOUBLE PRECISION NOT NULL,
  "holders"     DOUBLE PRECISION NOT NULL,
  "liquidity"   DOUBLE PRECISION NOT NULL,
  "sentiment"   DOUBLE PRECISION NOT NULL,
  "momentum"    DOUBLE PRECISION NOT NULL,
  "sampleCount" INTEGER NOT NULL,
  "reason"      TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConvictionWeightsHistory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ConvictionWeightsHistory_userId_createdAt_idx"   ON "ConvictionWeightsHistory"("userId", "createdAt");
CREATE UNIQUE INDEX "ConvictionWeightsHistory_userId_version_key" ON "ConvictionWeightsHistory"("userId", "version");

ALTER TABLE "UserConvictionWeights" ADD CONSTRAINT "UserConvictionWeights_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConvictionWeightsHistory" ADD CONSTRAINT "ConvictionWeightsHistory_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable Trade: per-trade conviction breakdown snapshot
ALTER TABLE "Trade" ADD COLUMN "convictionBreakdown" JSONB;
ALTER TABLE "Trade" ADD COLUMN "convictionVersion"   INTEGER;

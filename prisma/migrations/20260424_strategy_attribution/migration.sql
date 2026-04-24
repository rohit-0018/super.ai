-- L3: Strategy attribution + performance memory.
-- Adds strategyId on Trade, rejection reason/category on ApprovalRequest,
-- StrategyPerformance aggregates table, scoreBreakdown on UserStrategy.

-- CreateEnum
CREATE TYPE "RejectCategory" AS ENUM ('TOO_RISKY', 'WRONG_TOKEN', 'BAD_TIMING', 'WRONG_SIZE', 'OTHER');

-- AlterTable Trade: attribute each trade to a strategy (nullable for manual/chat trades)
ALTER TABLE "Trade" ADD COLUMN "strategyId" TEXT;
CREATE INDEX "Trade_userId_strategyId_idx" ON "Trade"("userId", "strategyId");
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_strategyId_fkey"
  FOREIGN KEY ("strategyId") REFERENCES "UserStrategy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable ApprovalRequest: capture rejection reason
ALTER TABLE "ApprovalRequest" ADD COLUMN "rejectReason" TEXT;
ALTER TABLE "ApprovalRequest" ADD COLUMN "rejectCategory" "RejectCategory";

-- AlterTable UserStrategy: breakdown JSON for the new composite score
ALTER TABLE "UserStrategy" ADD COLUMN "scoreBreakdown" JSONB;

-- CreateTable StrategyPerformance
CREATE TABLE "StrategyPerformance" (
  "strategyId"         TEXT NOT NULL,
  "userId"             TEXT NOT NULL,
  "sampleCount"        INTEGER NOT NULL DEFAULT 0,
  "sampleCountAllTime" INTEGER NOT NULL DEFAULT 0,
  "wins"               INTEGER NOT NULL DEFAULT 0,
  "losses"             INTEGER NOT NULL DEFAULT 0,
  "totalPnlUsd"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalPnlUsdAllTime" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "avgPnlUsd"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "stdevPnlUsd"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "maxDrawdownUsd"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "avgHoldMinutes"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "approvalsAccepted"  INTEGER NOT NULL DEFAULT 0,
  "approvalsRejected"  INTEGER NOT NULL DEFAULT 0,
  "approvalAcceptRate" DOUBLE PRECISION,
  "lastTradeAt"        TIMESTAMP(3),
  "lastComputedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StrategyPerformance_pkey" PRIMARY KEY ("strategyId")
);

CREATE INDEX "StrategyPerformance_userId_idx" ON "StrategyPerformance"("userId");

ALTER TABLE "StrategyPerformance" ADD CONSTRAINT "StrategyPerformance_strategyId_fkey"
  FOREIGN KEY ("strategyId") REFERENCES "UserStrategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Progressive learning system: per-user config, user-authored + learned strategies,
-- and a pending-approval queue for autonomous trades.

-- CreateEnum
CREATE TYPE "AutonomyLevel" AS ENUM ('MANUAL', 'GUIDED', 'SEMI_AUTO', 'FULL_AUTO');

-- CreateEnum
CREATE TYPE "StrategySource" AS ENUM ('LEARNED', 'USER_DEFINED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ApprovalChannel" AS ENUM ('WEB', 'TELEGRAM');

-- AlterEnum (Postgres 12+ allows multiple ADD VALUE in one migration file)
ALTER TYPE "AgentKind" ADD VALUE 'LEARNING';
ALTER TYPE "AgentKind" ADD VALUE 'STRATEGY';

-- CreateTable
CREATE TABLE "LearningConfig" (
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "autonomyLevel" "AutonomyLevel" NOT NULL DEFAULT 'MANUAL',
    "maxTradeUsd" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "dailyLimit" INTEGER NOT NULL DEFAULT 3,
    "dailyUsedCount" INTEGER NOT NULL DEFAULT 0,
    "dailyResetAt" TIMESTAMP(3),
    "approvalRequired" BOOLEAN NOT NULL DEFAULT true,
    "approvalTimeoutMin" INTEGER NOT NULL DEFAULT 5,
    "approvalChannels" "ApprovalChannel"[],
    "onTimeout" TEXT NOT NULL DEFAULT 'reject',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearningConfig_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "UserStrategy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" "StrategySource" NOT NULL,
    "definition" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "score" DOUBLE PRECISION,
    "lastRationale" TEXT,
    "lastScoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserStrategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "strategyId" TEXT,
    "agentId" TEXT,
    "tradeIntent" JSONB NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "respondedVia" "ApprovalChannel",
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserStrategy_userId_enabled_idx" ON "UserStrategy"("userId", "enabled");

-- CreateIndex
CREATE INDEX "ApprovalRequest_userId_status_idx" ON "ApprovalRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_expiresAt_idx" ON "ApprovalRequest"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "LearningConfig" ADD CONSTRAINT "LearningConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserStrategy" ADD CONSTRAINT "UserStrategy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "UserStrategy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

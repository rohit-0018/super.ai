-- Phase 4: Trade+ Fast Path — 11 new tables for signal ingestion, rule evaluation,
-- sizing/entry/exit/risk policies, and full audit trail.

CREATE TYPE "SignalSourceKind" AS ENUM ('TELEGRAM_CHANNEL', 'TELEGRAM_BOT', 'WEBHOOK', 'MANUAL');
CREATE TYPE "SignalTrust" AS ENUM ('UNTRUSTED', 'LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "RuleSetStatus" AS ENUM ('DRAFT', 'CANARY', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "RuleOutcomeStatus" AS ENUM ('OPEN', 'WIN', 'LOSS', 'SKIPPED', 'ERROR');

CREATE TABLE IF NOT EXISTS "SignalSource" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "walletId" TEXT,
  "kind" "SignalSourceKind" NOT NULL,
  "name" TEXT NOT NULL,
  "externalRef" TEXT,
  "trust" "SignalTrust" NOT NULL DEFAULT 'MEDIUM',
  "fastPathEnabled" BOOLEAN NOT NULL DEFAULT false,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignalSource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignalSource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "SignalSource_userId_enabled_idx" ON "SignalSource"("userId", "enabled");

CREATE TABLE IF NOT EXISTS "Signal" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "traceId" TEXT NOT NULL,
  "rawText" TEXT,
  "tokenAddress" TEXT,
  "ticker" TEXT,
  "chain" "Chain",
  "metadata" JSONB,
  "fastPath" BOOLEAN NOT NULL DEFAULT false,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Signal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Signal_traceId_key" UNIQUE ("traceId"),
  CONSTRAINT "Signal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Signal_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "SignalSource"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Signal_userId_createdAt_idx" ON "Signal"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "Signal_tokenAddress_idx" ON "Signal"("tokenAddress");

CREATE TABLE IF NOT EXISTS "RuleSet" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "RuleSetStatus" NOT NULL DEFAULT 'DRAFT',
  "canaryCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RuleSet_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RuleSet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "RuleSet_userId_status_idx" ON "RuleSet"("userId", "status");

CREATE TABLE IF NOT EXISTS "Rule" (
  "id" TEXT NOT NULL,
  "ruleSetId" TEXT NOT NULL,
  "name" TEXT,
  "priority" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "Rule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Rule_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "RuleSet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Rule_ruleSetId_idx" ON "Rule"("ruleSetId");

CREATE TABLE IF NOT EXISTS "Condition" (
  "id" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "operator" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  CONSTRAINT "Condition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Condition_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Condition_ruleId_idx" ON "Condition"("ruleId");

CREATE TABLE IF NOT EXISTS "RuleBinding" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "ruleSetId" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "scopeRef" TEXT,
  CONSTRAINT "RuleBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RuleBinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RuleBinding_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "RuleSet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "RuleBinding_userId_scope_scopeRef_idx" ON "RuleBinding"("userId", "scope", "scopeRef");

CREATE TABLE IF NOT EXISTS "SizingPolicy" (
  "id" TEXT NOT NULL,
  "ruleSetId" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "fixedUsd" DOUBLE PRECISION,
  "pctPortfolio" DOUBLE PRECISION,
  "kellyFraction" DOUBLE PRECISION DEFAULT 0.25,
  "maxUsd" DOUBLE PRECISION,
  CONSTRAINT "SizingPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SizingPolicy_ruleSetId_key" UNIQUE ("ruleSetId"),
  CONSTRAINT "SizingPolicy_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "RuleSet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "EntryPolicy" (
  "id" TEXT NOT NULL,
  "ruleSetId" TEXT NOT NULL,
  "orderType" TEXT NOT NULL DEFAULT 'market',
  "slippageBps" INTEGER NOT NULL DEFAULT 300,
  "router" TEXT NOT NULL DEFAULT 'jupiter',
  "limitOffsetBps" INTEGER,
  CONSTRAINT "EntryPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EntryPolicy_ruleSetId_key" UNIQUE ("ruleSetId"),
  CONSTRAINT "EntryPolicy_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "RuleSet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "ExitPolicy" (
  "id" TEXT NOT NULL,
  "ruleSetId" TEXT NOT NULL,
  "stopLossPct" DOUBLE PRECISION DEFAULT -25,
  "stopLossSize" DOUBLE PRECISION DEFAULT 1.0,
  "tp1Pct" DOUBLE PRECISION DEFAULT 50,
  "tp1Size" DOUBLE PRECISION DEFAULT 0.5,
  "tp2Pct" DOUBLE PRECISION DEFAULT 150,
  "tp2Size" DOUBLE PRECISION DEFAULT 0.3,
  "trailingPct" DOUBLE PRECISION,
  "trailingSize" DOUBLE PRECISION DEFAULT 0.2,
  "breakEvenAt" DOUBLE PRECISION DEFAULT 30,
  "timeStopHours" DOUBLE PRECISION DEFAULT 4,
  "timeStopPct" DOUBLE PRECISION DEFAULT -10,
  CONSTRAINT "ExitPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExitPolicy_ruleSetId_key" UNIQUE ("ruleSetId"),
  CONSTRAINT "ExitPolicy_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "RuleSet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "RiskPolicy" (
  "id" TEXT NOT NULL,
  "ruleSetId" TEXT NOT NULL,
  "maxPerTradeUsd" DOUBLE PRECISION,
  "maxDailyUsd" DOUBLE PRECISION,
  "cooldownSeconds" INTEGER DEFAULT 0,
  "maxTiltStreak" INTEGER DEFAULT 3,
  "minRiskScore" INTEGER DEFAULT 0,
  CONSTRAINT "RiskPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RiskPolicy_ruleSetId_key" UNIQUE ("ruleSetId"),
  CONSTRAINT "RiskPolicy_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "RuleSet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "RuleFiring" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "signalId" TEXT NOT NULL,
  "ruleSetId" TEXT NOT NULL,
  "traceId" TEXT,
  "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "latencyMs" INTEGER,
  CONSTRAINT "RuleFiring_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RuleFiring_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RuleFiring_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RuleFiring_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "RuleSet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "RuleFiring_userId_firedAt_idx" ON "RuleFiring"("userId", "firedAt");
CREATE INDEX IF NOT EXISTS "RuleFiring_ruleSetId_idx" ON "RuleFiring"("ruleSetId");

CREATE TABLE IF NOT EXISTS "RuleOutcome" (
  "id" TEXT NOT NULL,
  "firingId" TEXT NOT NULL,
  "status" "RuleOutcomeStatus" NOT NULL DEFAULT 'OPEN',
  "tradeId" TEXT,
  "entryUsd" DOUBLE PRECISION,
  "exitUsd" DOUBLE PRECISION,
  "pnlUsd" DOUBLE PRECISION,
  "pnlPct" DOUBLE PRECISION,
  "holdMinutes" INTEGER,
  "exitReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RuleOutcome_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RuleOutcome_firingId_key" UNIQUE ("firingId"),
  CONSTRAINT "RuleOutcome_firingId_fkey" FOREIGN KEY ("firingId") REFERENCES "RuleFiring"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "RuleOutcome_status_idx" ON "RuleOutcome"("status");

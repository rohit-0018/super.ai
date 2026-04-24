-- L4: Declarative intent memory. Natural-language user rules extracted from
-- chat and rejections; enforced by autonomous-trader before guardrails.

-- CreateEnum
CREATE TYPE "IntentSource" AS ENUM ('CHAT', 'REJECTION', 'MANUAL', 'ONBOARDING', 'BACKFILL');
CREATE TYPE "IntentScope" AS ENUM ('BLOCKLIST', 'ALLOWLIST', 'SIZING', 'TIMING', 'RISK', 'PREFERENCE');
CREATE TYPE "IntentStatus" AS ENUM ('ACTIVE', 'PROPOSED', 'CONFLICTED', 'RETIRED');

-- CreateTable
CREATE TABLE "UserIntentRule" (
  "id"               TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "text"             TEXT NOT NULL,
  "rule"             JSONB NOT NULL,
  "source"           "IntentSource" NOT NULL,
  "scope"            "IntentScope" NOT NULL,
  "status"           "IntentStatus" NOT NULL DEFAULT 'ACTIVE',
  "priority"         INTEGER NOT NULL DEFAULT 50,
  "confidence"       DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "lastAppliedAt"    TIMESTAMP(3),
  "retiredReason"    TEXT,
  "sourceApprovalId" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserIntentRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserIntentRule_userId_status_scope_idx" ON "UserIntentRule"("userId", "status", "scope");
CREATE INDEX "UserIntentRule_userId_lastAppliedAt_idx" ON "UserIntentRule"("userId", "lastAppliedAt");

ALTER TABLE "UserIntentRule" ADD CONSTRAINT "UserIntentRule_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

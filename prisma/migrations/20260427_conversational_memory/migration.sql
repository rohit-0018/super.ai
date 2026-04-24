-- L6: conversational long-term memory. Adds Conversation/ChatMessage/UserNote
-- + per-user learning toggles. Legacy ConversationMessage stays in place.

-- CreateEnum
CREATE TYPE "ChatChannel" AS ENUM ('WEB', 'TELEGRAM', 'API');
CREATE TYPE "ChatRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM', 'TOOL');
CREATE TYPE "NoteCategory" AS ENUM ('PREFERENCE', 'CONTEXT', 'AVOIDANCE', 'GOAL', 'TRADING_STYLE', 'OTHER');
CREATE TYPE "NoteStatus" AS ENUM ('ACTIVE', 'RETIRED');

-- AlterTable LearningConfig: per-user fine-grained memory toggles
ALTER TABLE "LearningConfig" ADD COLUMN "chatMemoryEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "LearningConfig" ADD COLUMN "noteExtractionEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable Conversation
CREATE TABLE "Conversation" (
  "id"                  TEXT NOT NULL,
  "userId"              TEXT NOT NULL,
  "channel"             "ChatChannel" NOT NULL,
  "title"               TEXT,
  "summary"             TEXT,
  "summarizedThroughId" TEXT,
  "lastMessageAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "messageCount"        INTEGER NOT NULL DEFAULT 0,
  "approxTokenCount"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt"            TIMESTAMP(3),
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Conversation_userId_lastMessageAt_idx"      ON "Conversation"("userId", "lastMessageAt");
CREATE INDEX "Conversation_userId_channel_closedAt_idx"   ON "Conversation"("userId", "channel", "closedAt");

-- CreateTable ChatMessage
CREATE TABLE "ChatMessage" (
  "id"             TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "role"           "ChatRole" NOT NULL,
  "content"        TEXT NOT NULL,
  "toolCalls"      JSONB,
  "toolResults"    JSONB,
  "meta"           JSONB,
  "tokensIn"       INTEGER,
  "tokensOut"      INTEGER,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ChatMessage_userId_createdAt_idx"         ON "ChatMessage"("userId", "createdAt");
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");

-- CreateTable UserNote
CREATE TABLE "UserNote" (
  "id"                    TEXT NOT NULL,
  "userId"                TEXT NOT NULL,
  "category"              "NoteCategory" NOT NULL,
  "content"               TEXT NOT NULL,
  "sourceConversationIds" TEXT[],
  "confidence"            DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  "confirmCount"          INTEGER NOT NULL DEFAULT 1,
  "lastConfirmedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status"                "NoteStatus" NOT NULL DEFAULT 'ACTIVE',
  "retiredAt"             TIMESTAMP(3),
  "retiredReason"         TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "UserNote_userId_status_category_idx"    ON "UserNote"("userId", "status", "category");
CREATE INDEX "UserNote_userId_lastConfirmedAt_idx"    ON "UserNote"("userId", "lastConfirmedAt");

-- FKs
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserNote" ADD CONSTRAINT "UserNote_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

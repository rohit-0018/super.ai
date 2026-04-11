-- CreateEnum
CREATE TYPE "Chain" AS ENUM ('SOLANA', 'EVM');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP_LOSS', 'TAKE_PROFIT', 'TRAILING_STOP', 'BRACKET', 'DCA');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'ACTIVE', 'FILLED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "TradeMode" AS ENUM ('LIVE', 'PAPER');

-- CreateEnum
CREATE TYPE "AgentKind" AS ENUM ('DCA', 'STOP_LOSS', 'COPY_TRADE', 'POSITION_MONITOR', 'SNIPE', 'BRIEFING');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('RUNNING', 'PAUSED', 'KILLED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARN', 'CRITICAL');

-- CreateEnum
CREATE TYPE "Exchange" AS ENUM ('BINANCE', 'BYBIT', 'OKX');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "primaryWallet" TEXT,
    "telegramChatId" TEXT,
    "riskProfile" JSONB,
    "emotionalState" JSONB,
    "paperMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "encryptedDek" TEXT NOT NULL,
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "nonce" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingDna" (
    "userId" TEXT NOT NULL,
    "winRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgHoldMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "riskScore" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "totalTrades" INTEGER NOT NULL DEFAULT 0,
    "behavioralSignals" JSONB,
    "preferences" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingDna_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "TokenIntel" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "address" TEXT NOT NULL,
    "symbol" TEXT,
    "name" TEXT,
    "securityScore" DOUBLE PRECISION,
    "convictionScore" DOUBLE PRECISION,
    "holderData" JSONB,
    "securityFlags" JSONB,
    "sentiment" JSONB,
    "priceUsd" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenIntel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "OrderType" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "chain" "Chain" NOT NULL,
    "tokenIn" TEXT NOT NULL,
    "tokenOut" TEXT NOT NULL,
    "amountIn" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "userId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "tokenIn" TEXT NOT NULL,
    "tokenOut" TEXT NOT NULL,
    "amountIn" TEXT NOT NULL,
    "amountOut" TEXT NOT NULL,
    "priceUsd" DOUBLE PRECISION,
    "pnlUsd" DOUBLE PRECISION,
    "mode" "TradeMode" NOT NULL DEFAULT 'LIVE',
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "AgentKind" NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'RUNNING',
    "params" JSONB NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'INFO',
    "payload" JSONB NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "payload" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuardrailConfig" (
    "userId" TEXT NOT NULL,
    "perTradeUsd" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "dailyUsd" DOUBLE PRECISION NOT NULL DEFAULT 2000,
    "maxSlippageBps" INTEGER NOT NULL DEFAULT 150,
    "whitelist" TEXT[],
    "blacklist" TEXT[],
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuardrailConfig_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "CexConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exchange" "Exchange" NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "encryptedDek" TEXT NOT NULL,
    "readOnly" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CexConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperBalance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "amount" TEXT NOT NULL,

    CONSTRAINT "PaperBalance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_primaryWallet_key" ON "User"("primaryWallet");

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramChatId_key" ON "User"("telegramChatId");

-- CreateIndex
CREATE INDEX "Wallet_userId_idx" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_address_key" ON "Wallet"("userId", "address");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "ConversationMessage_userId_createdAt_idx" ON "ConversationMessage"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TokenIntel_chain_address_key" ON "TokenIntel"("chain", "address");

-- CreateIndex
CREATE INDEX "Order_userId_status_idx" ON "Order"("userId", "status");

-- CreateIndex
CREATE INDEX "Trade_userId_createdAt_idx" ON "Trade"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Agent_userId_status_idx" ON "Agent"("userId", "status");

-- CreateIndex
CREATE INDEX "AlertEvent_userId_createdAt_idx" ON "AlertEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CexConnection_userId_exchange_key" ON "CexConnection"("userId", "exchange");

-- CreateIndex
CREATE UNIQUE INDEX "PaperBalance_userId_token_key" ON "PaperBalance"("userId", "token");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingDna" ADD CONSTRAINT "TradingDna_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardrailConfig" ADD CONSTRAINT "GuardrailConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CexConnection" ADD CONSTRAINT "CexConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperBalance" ADD CONSTRAINT "PaperBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

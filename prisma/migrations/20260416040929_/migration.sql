-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notificationPrefs" JSONB;

-- CreateTable
CREATE TABLE "PriceAlert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "targetUsd" DOUBLE PRECISION NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'below',
    "fired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FastLaneConfig" (
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "trustedChannels" TEXT[],
    "maxPerTradeUsd" DOUBLE PRECISION NOT NULL DEFAULT 500,
    "maxDailyUsd" DOUBLE PRECISION NOT NULL DEFAULT 2000,
    "skipWashTradeCheck" BOOLEAN NOT NULL DEFAULT true,
    "skipRiskEngine" BOOLEAN NOT NULL DEFAULT true,
    "skipGuardrails" BOOLEAN NOT NULL DEFAULT false,
    "skipInjectionDetect" BOOLEAN NOT NULL DEFAULT true,
    "skipDuplicateDetect" BOOLEAN NOT NULL DEFAULT true,
    "defaultSlippageBps" INTEGER NOT NULL DEFAULT 200,
    "defaultWalletId" TEXT,
    "allowedTokens" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FastLaneConfig_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "PriceAlert_userId_fired_idx" ON "PriceAlert"("userId", "fired");

-- AddForeignKey
ALTER TABLE "PriceAlert" ADD CONSTRAINT "PriceAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FastLaneConfig" ADD CONSTRAINT "FastLaneConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

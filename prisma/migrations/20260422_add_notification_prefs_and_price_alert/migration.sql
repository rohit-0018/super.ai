-- Schema drift repair: seed + production code both expect fields that were
-- added to schema.prisma but never migrated into the DB.

-- User.notificationPrefs (used by seed.ts and the telegram/email wiring)
ALTER TABLE "User" ADD COLUMN "notificationPrefs" JSONB;

-- PriceAlert table — declared in schema but never migrated.
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

CREATE INDEX "PriceAlert_userId_fired_idx" ON "PriceAlert"("userId", "fired");

ALTER TABLE "PriceAlert"
    ADD CONSTRAINT "PriceAlert_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

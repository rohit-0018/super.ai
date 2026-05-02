-- CreateTable
CREATE TABLE IF NOT EXISTS "ProviderConfig" (
    "id"            TEXT NOT NULL,
    "key"           TEXT NOT NULL,
    "displayName"   TEXT NOT NULL,
    "dataGroup"     TEXT NOT NULL,
    "priority"      INTEGER NOT NULL DEFAULT 100,
    "reqsPerWindow" INTEGER NOT NULL DEFAULT 60,
    "windowSec"     INTEGER NOT NULL DEFAULT 60,
    "cooldownSec"   INTEGER NOT NULL DEFAULT 120,
    "enabled"       BOOLEAN NOT NULL DEFAULT true,
    "requiresKey"   TEXT,
    "baseUrl"       TEXT,
    "notes"         TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
DO $$ BEGIN
  CREATE UNIQUE INDEX "ProviderConfig_key_key" ON "ProviderConfig"("key");
EXCEPTION WHEN duplicate_table THEN NULL;
END; $$;

DO $$ BEGIN
  CREATE INDEX "ProviderConfig_dataGroup_priority_idx" ON "ProviderConfig"("dataGroup", "priority");
EXCEPTION WHEN duplicate_table THEN NULL;
END; $$;

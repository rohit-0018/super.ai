ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT;
DO $$ BEGIN
  CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");
EXCEPTION WHEN duplicate_object THEN NULL;
END; $$;

CREATE TABLE IF NOT EXISTS "PhoneOtp" (
  "id"        TEXT NOT NULL,
  "phone"     TEXT NOT NULL,
  "otpHash"   TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "used"      BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PhoneOtp_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PhoneOtp_phone_idx" ON "PhoneOtp"("phone");

-- Add spending policy confirmation threshold to GuardrailConfig
ALTER TABLE "GuardrailConfig" ADD COLUMN IF NOT EXISTS "confirmationThresholdUsd" DOUBLE PRECISION;

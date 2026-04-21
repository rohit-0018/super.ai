#!/usr/bin/env bash
# Render pre-deploy hook — runs once before a new release goes live.
# Applies pending migrations, then (optionally) seeds demo data.
# SEED_DB_ON_DEPLOY=true is set once on initial deploy — switch to "false" after
# you go live so a redeploy does not reset demo rows on top of user data.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "✗ DATABASE_URL not set; aborting."
  exit 1
fi

echo "▶ prisma migrate deploy"
pnpm prisma migrate deploy --schema=./prisma/schema.prisma

if [[ "${SEED_DB_ON_DEPLOY:-false}" == "true" ]]; then
  echo "▶ seeding demo data"
  pnpm tsx prisma/seed.ts
else
  echo "ℹ SEED_DB_ON_DEPLOY=false, skipping seed"
fi

echo "✔ pre-deploy complete"

#!/usr/bin/env bash
# Render start hook for the free-plan API service.
# preDeployCommand is gated behind paid plans, so we apply migrations (and
# optional seed) right before booting the server. Runs every cold start, but
# `prisma migrate deploy` is a no-op when the schema is already current.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "✗ DATABASE_URL not set; aborting."
  exit 1
fi

# pnpm is installed under a user-local prefix during build; put it on PATH for runtime too.
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"

echo "▶ prisma migrate deploy"
pnpm prisma migrate deploy --schema=./prisma/schema.prisma

if [[ "${SEED_DB_ON_DEPLOY:-false}" == "true" ]]; then
  echo "▶ seeding demo data"
  pnpm tsx prisma/seed.ts || echo "⚠ seed failed, continuing"
fi

echo "▶ launching API"
exec node apps/api/dist/main.js

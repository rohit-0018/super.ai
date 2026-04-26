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

echo "▶ resolving any previously-failed migrations"
pnpm prisma migrate resolve --rolled-back 20260424041722_ --schema=./prisma/schema.prisma 2>/dev/null || true

echo "▶ prisma migrate deploy"
pnpm prisma migrate deploy --schema=./prisma/schema.prisma

# ─── Drift guard ────────────────────────────────────────────────────────────
# After migrations apply, the live DB should match schema.prisma exactly.
# `migrate diff` with `--exit-code` returns:
#   0 = no diff (healthy)
#   2 = diff present (schema declares fields not in any migration → drift)
#   1 = command error
# Fail loudly on 2 so we never boot with a DB the code expects to have more
# columns than it does (the exact bug that crashed the last seed run).
echo "▶ prisma drift check (schema.prisma vs live DB)"
set +e
pnpm prisma migrate diff \
  --from-schema-datasource ./prisma/schema.prisma \
  --to-schema-datamodel ./prisma/schema.prisma \
  --exit-code >/tmp/prisma-drift.log 2>&1
DRIFT_EXIT=$?
set -e
if [[ "$DRIFT_EXIT" -eq 2 ]]; then
  echo "✗ schema drift detected after migrate deploy:"
  cat /tmp/prisma-drift.log
  echo ""
  echo "   To fix: run locally → \`pnpm prisma migrate dev --name describe_your_change\`"
  echo "   then commit the generated migration folder and redeploy."
  exit 1
elif [[ "$DRIFT_EXIT" -ne 0 ]]; then
  echo "⚠ prisma drift check errored (exit=$DRIFT_EXIT); continuing boot"
  cat /tmp/prisma-drift.log || true
fi

if [[ "${SEED_DB_ON_DEPLOY:-false}" == "true" ]]; then
  echo "▶ seeding demo data"
  pnpm tsx prisma/seed.ts || echo "⚠ seed failed, continuing"
fi

echo "▶ launching API"
exec node apps/api/dist/main.js

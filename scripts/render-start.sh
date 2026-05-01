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
# Resolve every migration that could ever be stuck — safe to call even if not stuck (no-ops).
for migration in \
  20260424041722_ \
  20260424_strategy_attribution \
  20260425_intent_memory \
  20260427_conversational_memory \
  20260428_episodic_memory \
  20260429_conviction_personalization \
  20260429_snipe_tables \
  20260430_snipe_trade_error_msg \
  20260430_phone_auth \
  20260502_alert_read_at
do
  pnpm prisma migrate resolve --rolled-back "$migration" \
    --schema=./prisma/schema.prisma 2>/dev/null || true
done

echo "▶ prisma migrate deploy"
pnpm prisma migrate deploy --schema=./prisma/schema.prisma

# ─── Drift check (informational only) ──────────────────────────────────────
# Reports schema drift but does NOT block boot. The HNSW index on TradeEpisode
# is created by migrations but can't be represented in schema.prisma (Prisma
# has no HNSW syntax), so migrate diff always shows a false-positive diff for
# that index. Making this fatal would permanently block every deploy.
echo "▶ prisma drift check (schema.prisma vs live DB)"
set +e
pnpm prisma migrate diff \
  --from-schema-datasource ./prisma/schema.prisma \
  --to-schema-datamodel ./prisma/schema.prisma \
  --exit-code >/tmp/prisma-drift.log 2>&1
DRIFT_EXIT=$?
set -e
if [[ "$DRIFT_EXIT" -eq 2 ]]; then
  echo "⚠ schema drift detected (non-fatal — likely the HNSW index):"
  cat /tmp/prisma-drift.log || true
elif [[ "$DRIFT_EXIT" -ne 0 ]]; then
  echo "⚠ prisma drift check errored (exit=$DRIFT_EXIT); continuing"
  cat /tmp/prisma-drift.log || true
else
  echo "✓ no schema drift"
fi

if [[ "${SEED_DB_ON_DEPLOY:-false}" == "true" ]]; then
  echo "▶ seeding demo data"
  pnpm tsx prisma/seed.ts || echo "⚠ seed failed, continuing"
fi

echo "▶ launching API"
exec node apps/api/dist/main.js

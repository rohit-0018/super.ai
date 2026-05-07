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

# ─── Resolve any failed/stuck migrations ─────────────────────────────────
# Always runs. Each `migrate resolve --rolled-back` call is harmless if the
# migration was never applied (the error gets swallowed by `|| true`), so this
# is safe on both fresh and existing DBs. We can't reliably detect a fresh DB
# from this shell — `prisma db execute` doesn't print SELECT results to stdout —
# so the simplest correct thing is to attempt resolution unconditionally.
echo "▶ resolving any previously-failed migrations (idempotent)"
for migration in \
  20260424041722_ \
  20260424_strategy_attribution \
  20260425_intent_memory \
  20260427_conversational_memory \
  20260428_episodic_memory \
  20260428_snipe_attempts \
  20260429_conviction_personalization \
  20260429_snipe_buy_snapshot \
  20260429_snipe_tables \
  20260429a_snipe_attempts \
  20260429b_snipe_buy_snapshot \
  20260430_snipe_trade_error_msg \
  20260430_phone_auth \
  20260502_alert_read_at \
  20260503_provider_config \
  20260503010000_schema_drift_fix
do
  # `migrate resolve --rolled-back` only succeeds when the migration is in
  # FAILED state. It errors for already-applied or never-applied migrations,
  # which is fine — those need no action. We log all three outcomes clearly.
  out=$(pnpm prisma migrate resolve --rolled-back "$migration" \
    --schema=./prisma/schema.prisma 2>&1) && \
    echo "  ↳ $migration: was failed → rolled back" || \
    echo "  ↳ $migration: ok (already applied or not in table — no action)"
done

# ─── Apply migrations FIRST ───────────────────────────────────────────────
# On a fresh DB this creates every enum (Chain, OrderType, …) and table.
# On an existing DB it applies any pending migrations and is a no-op when
# the schema is already current. Must run BEFORE bootstrap.sql, which
# references types/tables created by these migrations.
echo "▶ prisma migrate deploy"
pnpm prisma migrate deploy --schema=./prisma/schema.prisma

# ─── Bootstrap SQL — fail-safe schema reconciliation ──────────────────────
# Idempotent ALTER/CREATE statements as a belt-and-suspenders layer: even if
# `migrate deploy` silently skips a migration (state corruption, checksum
# mismatch, etc.), the schema is correct after this step. Runs AFTER migrate
# deploy because it references types/tables that only exist post-migration.
echo "▶ running bootstrap.sql (idempotent schema reconcile)"
pnpm prisma db execute --file ./prisma/bootstrap.sql --schema ./prisma/schema.prisma \
  || { echo "✗ bootstrap.sql failed — aborting boot"; exit 1; }
echo "✓ bootstrap.sql applied"

# Mark the migrations that bootstrap.sql also covers as applied, so Prisma's
# _prisma_migrations table reflects reality. --applied no-ops if already marked.
echo "▶ syncing _prisma_migrations tracking for bootstrap-covered migrations"
for m in 20260503_provider_config 20260503010000_schema_drift_fix; do
  pnpm prisma migrate resolve --applied "$m" \
    --schema=./prisma/schema.prisma 2>/dev/null || true
done

# ─── Drift check (informational only) ─────────────────────────────────────
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
# Render free plan caps the container at 512MB. Node's default heap target is
# ~1.4GB so V8 won't bother GC'ing until well past the OOM kill line. Cap the
# old-space at 400MB to leave headroom for native modules (Prisma engine,
# bs58/keccak, sharp, etc.) and force aggressive GC under pressure.
exec node --max-old-space-size=400 apps/api/dist/main.js

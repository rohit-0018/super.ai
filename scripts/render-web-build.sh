#!/usr/bin/env bash
# Render build step for the static web service.
# Builds the Next.js app with output: 'export' so everything lands in apps/web/out/.
set -euo pipefail

echo "─── env ─────────────────────────────────────────────"
node --version
npm --version
echo "pwd: $(pwd)"

# /usr/bin is read-only in Render's build container; install pnpm user-local.
echo "▶ install pnpm@9.1.0 (user-local)"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
npm install -g pnpm@9.1.0
pnpm --version

echo "▶ pnpm install (dev deps forced on; fall back to --no-frozen-lockfile if drift)"
NODE_ENV=development pnpm install --frozen-lockfile --prod=false --ignore-scripts=false \
  || { echo "⚠ lockfile drift — retrying with --no-frozen-lockfile"; \
       NODE_ENV=development pnpm install --no-frozen-lockfile --prod=false --ignore-scripts=false; }

echo "▶ next build (static export)"
NODE_ENV=production pnpm --filter @qwai/web build

if [[ ! -d apps/web/out ]]; then
  echo "✗ apps/web/out was not produced — check next.config.js output setting"
  exit 1
fi

echo "✔ web static build complete — publish apps/web/out"

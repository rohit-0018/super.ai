#!/usr/bin/env bash
# Render build step for the static web service.
# Builds the Next.js app with output: 'export' so everything lands in apps/web/out/.
set -euo pipefail

echo "▶ corepack enable + pnpm@9"
corepack enable
corepack prepare pnpm@9.1.0 --activate

echo "▶ pnpm install"
pnpm install --frozen-lockfile || pnpm install

echo "▶ next build (static export)"
pnpm --filter @qwai/web build

if [[ ! -d apps/web/out ]]; then
  echo "✗ apps/web/out was not produced — check next.config.js output setting"
  exit 1
fi

echo "✔ web static build complete — publish apps/web/out"

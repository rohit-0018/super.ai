#!/usr/bin/env bash
# Render build step for the static web service.
# Builds the Next.js app with output: 'export' so everything lands in apps/web/out/.
set -euo pipefail

# /usr/bin is read-only in Render's build container; install pnpm user-local.
echo "▶ install pnpm@9.1.0 (user-local, avoids corepack /usr/bin write)"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
npm install -g pnpm@9.1.0
pnpm --version

echo "▶ pnpm install"
pnpm install --frozen-lockfile || pnpm install

echo "▶ next build (static export)"
pnpm --filter @qwai/web build

if [[ ! -d apps/web/out ]]; then
  echo "✗ apps/web/out was not produced — check next.config.js output setting"
  exit 1
fi

echo "✔ web static build complete — publish apps/web/out"

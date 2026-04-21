#!/usr/bin/env bash
# Render build step for the API service.
# Installs deps (frozen lockfile), generates Prisma client, compiles Nest to dist/.
set -euo pipefail

echo "▶ corepack enable + pnpm@9"
corepack enable
corepack prepare pnpm@9.1.0 --activate

echo "▶ pnpm install"
pnpm install --frozen-lockfile || pnpm install

echo "▶ prisma generate"
pnpm prisma generate --schema=./prisma/schema.prisma

echo "▶ build @super-ai/security (workspace dep)"
pnpm --filter @super-ai/security build

echo "▶ build API"
pnpm --filter @qwai/api build

echo "✔ API build complete"

#!/usr/bin/env bash
# Render build step for the API service.
# Installs deps (frozen lockfile), generates Prisma client, compiles Nest to dist/.
set -euo pipefail

# Render's build container has /usr/bin read-only, so `corepack enable` fails
# when it tries to shim pnpm there. Install pnpm into the project-local npm
# prefix instead and put it on PATH for the rest of the build.
echo "▶ install pnpm@9.1.0 (user-local, avoids corepack /usr/bin write)"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
npm install -g pnpm@9.1.0
pnpm --version

echo "▶ pnpm install"
pnpm install --frozen-lockfile || pnpm install

echo "▶ prisma generate"
pnpm prisma generate --schema=./prisma/schema.prisma

echo "▶ build @super-ai/security (workspace dep)"
pnpm --filter @super-ai/security build

echo "▶ build API"
pnpm --filter @qwai/api build

echo "✔ API build complete"

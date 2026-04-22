#!/usr/bin/env bash
# Render build step for the API service.
# Installs deps (forcing dev deps in, since Render sets NODE_ENV=production),
# generates Prisma client, compiles @super-ai/security + @qwai/api to dist/.
set -euo pipefail

echo "─── env ─────────────────────────────────────────────"
node --version
npm --version
echo "pwd: $(pwd)"

# Render's build container has /usr/bin read-only, so `corepack enable` fails.
# Install pnpm into a user-local npm prefix instead and put it on PATH.
echo "▶ install pnpm@9.1.0 (user-local)"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
npm install -g pnpm@9.1.0
pnpm --version

# Render sets NODE_ENV=production on the service, which makes pnpm omit
# devDependencies. Force a full install so @types/*, typescript, nestjs CLI,
# prisma, etc. are available for the build.
echo "▶ pnpm install (dev deps forced on; fall back to --no-frozen-lockfile if drift)"
# CI defaults to frozen-lockfile. If package.json drifts from pnpm-lock.yaml
# (e.g. a dep version was bumped without regenerating the lockfile), retry
# without the frozen flag so the deploy still ships.
NODE_ENV=development pnpm install --frozen-lockfile --prod=false --ignore-scripts=false \
  || { echo "⚠ lockfile drift — retrying with --no-frozen-lockfile"; \
       NODE_ENV=development pnpm install --no-frozen-lockfile --prod=false --ignore-scripts=false; }

echo "▶ prisma generate"
NODE_ENV=development pnpm prisma generate --schema=./prisma/schema.prisma

echo "▶ build @super-ai/security"
NODE_ENV=development pnpm --filter @super-ai/security build

echo "▶ build @qwai/api"
NODE_ENV=development pnpm --filter @qwai/api build

# Sanity-check the produced artifacts so Render surfaces a clear error if
# a build silently produced nothing.
if [[ ! -f apps/api/dist/main.js ]]; then
  echo "✗ apps/api/dist/main.js missing — nest build did not emit output"
  exit 1
fi
if [[ ! -f security/dist/index.js ]]; then
  echo "✗ security/dist/index.js missing — tsc did not emit output"
  exit 1
fi

echo "✔ API build complete"

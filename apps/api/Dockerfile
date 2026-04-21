FROM node:20-alpine AS base
WORKDIR /workspace
RUN apk add --no-cache openssl
RUN corepack enable

FROM base AS build
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc* turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY security/package.json security/
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile || pnpm install
COPY security ./security
COPY apps/api ./apps/api
RUN pnpm prisma:generate
RUN pnpm --filter @super-ai/security build
RUN pnpm --filter @qwai/api build

FROM node:20-alpine AS run
WORKDIR /workspace
RUN apk add --no-cache openssl
RUN corepack enable
ENV NODE_ENV=production

# Copy the workspace (with resolved node_modules symlinks intact) from the
# build stage. pnpm's hoisted store + symlinks mean we must preserve the full
# workspace layout rather than trying to prune with `pnpm deploy` — that path
# collides with the root-level prisma CLI during symlink rewrite.
COPY --from=build /workspace ./

EXPOSE 4400
CMD ["node", "apps/api/dist/main.js"]

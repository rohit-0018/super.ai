FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc* turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @qwai/web... || pnpm install --filter @qwai/web...

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/web ./apps/web
RUN pnpm --filter @qwai/web build

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3001
CMD ["node", "apps/web/server.js"]

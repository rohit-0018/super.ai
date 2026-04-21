FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc* turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY security/package.json security/
RUN pnpm install --frozen-lockfile --filter @qwai/web... || pnpm install --filter @qwai/web...

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/web ./apps/web
RUN pnpm --filter @qwai/web build

# next.config.js uses output: 'export', so the build produces apps/web/out/.
# Serve it with a tiny static server.
FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g serve@14
COPY --from=build /app/apps/web/out ./out
EXPOSE 3001
CMD ["serve", "-s", "out", "-l", "3001"]

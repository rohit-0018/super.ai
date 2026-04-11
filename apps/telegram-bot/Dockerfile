FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc* turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/telegram-bot/package.json apps/telegram-bot/
RUN pnpm install --frozen-lockfile --filter @qwai/telegram-bot... || pnpm install --filter @qwai/telegram-bot...

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/telegram-bot ./apps/telegram-bot
RUN pnpm --filter @qwai/telegram-bot build

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/telegram-bot/dist ./dist
COPY --from=build /app/apps/telegram-bot/package.json ./package.json
CMD ["node", "dist/index.js"]

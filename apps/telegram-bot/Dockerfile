FROM node:20-alpine AS base
WORKDIR /workspace
RUN corepack enable

FROM base AS build
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc* turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/telegram-bot/package.json apps/telegram-bot/
RUN pnpm install --frozen-lockfile || pnpm install
COPY apps/telegram-bot ./apps/telegram-bot
RUN pnpm --filter @qwai/telegram-bot build
RUN pnpm --filter @qwai/telegram-bot deploy --prod /prod/bot

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /prod/bot ./
CMD ["node", "dist/index.js"]

FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc* turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/telegram-bot/package.json apps/telegram-bot/
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile --filter @qwai/api... || pnpm install --filter @qwai/api...

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
RUN pnpm prisma:generate
RUN pnpm --filter @qwai/api build

FROM node:20-alpine AS run
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY --from=build /app/apps/api/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/package.json ./package.json
COPY --from=build /app/prisma ./prisma
EXPOSE 4000
CMD ["node", "dist/main.js"]

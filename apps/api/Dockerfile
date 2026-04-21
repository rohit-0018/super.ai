FROM node:20-alpine AS base
WORKDIR /workspace
RUN apk add --no-cache openssl
RUN corepack enable

FROM base AS build
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc* turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile || pnpm install
COPY apps/api ./apps/api
RUN pnpm prisma:generate
RUN pnpm --filter @qwai/api build
# pnpm deploy produces a self-contained app dir with a flat node_modules
# containing all production deps (reflect-metadata, @nestjs/*, etc.) resolved.
RUN pnpm --filter @qwai/api deploy --prod /prod/api

FROM node:20-alpine AS run
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY --from=build /prod/api ./
COPY --from=build /workspace/prisma ./prisma
EXPOSE 4400
CMD ["node", "dist/main.js"]

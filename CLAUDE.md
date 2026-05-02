# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

pnpm + Turborepo monorepo. NestJS 10 API + Next.js 14 web + Prisma (Postgres) + BullMQ (Redis) + Grammy (Telegram). Workspace packages: `apps/*` and `security`.

## Daily commands

Use the Makefile as the canonical entry point — it wraps pnpm/turbo and handles port cleanup, infra, and Nvm sourcing for non-interactive shells.

```bash
make dev             # = dev-all: infra-up + api (with embedded Telegram bot) + worker + web, hot-reload, Ctrl+C stops all
make dev-api         # API only (nest --watch)
make dev-worker      # BullMQ worker only (tsx watch src/worker.ts)
make dev-web         # Next.js web only (port 3001)
make dev-kill        # Kill stray processes on :3001 and :4400

make infra-up        # postgres + redis via docker compose
make infra-nuke      # Wipe volumes (destructive)

make prisma-migrate  # prisma migrate dev (prompts for name)
make db-sync         # prisma db push + generate (fast dev iteration, no migration file)
make prisma-reset    # Full reset + rerun migrations (destructive)
make db-seed         # Load prisma/seed.sql into local DB (PGPASSWORD=qwai, port 55432)

make typecheck       # tsc --noEmit for api + web
make test            # turbo test (Jest)
make test-e2e        # turbo test:e2e (Playwright, web)
make lint            # turbo lint
make security-scan   # scripts/security-scan.sh
make load-test       # scripts/load-test.sh against http://localhost:4400/api
```

Single API test: `pnpm --filter @qwai/api exec jest <pattern>` (regex matches `*.spec.ts` under `apps/api/src`). Single web Playwright test: `pnpm --filter @qwai/web exec playwright test <file>`.

## Ports and local infra

- API: **4400** (`/api` global prefix → `http://localhost:4400/api`)
- Web: **3001**
- Postgres: **55432** (user/pass/db all `qwai`)
- Redis: **56379**

Docker is **only** for Postgres + Redis. API, worker, and web run natively on the host so file saves hot-reload.

## Architecture

### API (`apps/api/src`)

NestJS app registered in `app.module.ts`. Modules roughly track the feature taxonomy in `docs/FEATURES.md` (auth, wallets, market-data, token-intel, ai-agent, execution, guardrails, paper-trading, agents, analytics, social, cex, ws, users, news, security, telegram).

Two entry points share the same `AppModule`:
- `main.ts` — HTTP/WS server. Sets `api` global prefix, Helmet, `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`, enables shutdown hooks (required so BullMQ releases its port on SIGINT — otherwise dev restarts EADDRINUSE).
- `worker.ts` — `NestFactory.createApplicationContext` then `WorkerBootstrap.start()`. On Render, `QWAI_ROLE=all` means workers are started inline in the API process instead.

The **Telegram bot is embedded in the API process** (via `TelegramModule`), not a separate service. Same AI brain, same session layer.

Trace middleware runs before auth so `traceId` is stamped on every response and downstream services see it via `traceStore`.

Throttler: 120 req/min globally via `APP_GUARD`.

Env loading is redundant-on-purpose: `main.ts` and `ConfigModule.forRoot` both try `cwd/.env`, `cwd/../../.env`, and `__dirname/../../../.env` so the API finds the monorepo-root `.env` whether launched from `apps/api` or the repo root.

### Web (`apps/web`)

Next.js 14 App Router (`app/`). Routes: `dashboard`, `chat`, `analytics`, `wallets`, `social`, `settings`, `login`. Real-time updates via `useRealtime` socket.io hook (trade_confirmed + order_triggered auto-invalidate queries). Wallet connect through Solana wallet-adapter (Phantom) and ethers.js (MetaMask).

Built as a **static export** for Render (`next build` → `apps/web/out`), not SSR.

### Security package (`security/`)

Workspace lib `@super-ai/security`, imported by the API. Covers crypto (KMS envelope), audit, auth helpers, rate-limit, risk, compliance, anomaly detection, input/output sanitization. It has its own `tsc` build and must be built before the API (see `scripts/render-build.sh`). See `security/SECURITY_MODULE.md`.

### Prisma (`prisma/`)

Single schema for the whole app; enums include `Chain`, `OrderType`, `OrderStatus`, `TradeMode`, `AgentKind`, `AgentStatus`, `AlertSeverity`. Binary targets include `linux-musl-openssl-3.0.x` for Alpine runners. `seed.ts` (tsx) is the main seed; `seed.sql` is a faster dev shortcut loaded by `make db-seed`.

## Deployment

Render Blueprint (`render.yaml`): managed Postgres + managed Redis + one Node web service (`qwai-api`) + one static site (`qwai-web`). Everything is free-plan, so there's **no `preDeployCommand`** — migrations run at startup instead.

### Deploying from Claude Code

`scripts/deploy.sh` wraps the Render API so deploys can be triggered without leaving the terminal. **Always ask the user before triggering** — the script shows which service(s) you're about to deploy. Workflow:

1. Inspect the diff to figure out scope: backend (`apps/api/**`, `prisma/**`, `scripts/render-*.sh`, `render.yaml`) → `api`; frontend (`apps/web/**`) → `web`; both if both touched.
2. Tell the user what you'd deploy and why ("touched apps/api/src/telegram/* — deploy api?").
3. On approval, run `./scripts/deploy.sh trigger <api|web|both>` and capture the deploy ID.
4. Run `./scripts/deploy.sh watch <deployId>` to follow the build → live transition; report the terminal status.

Setup is one-time: user creates a Render API key (Dashboard → Account → API Keys), exports `RENDER_API_KEY` (or adds to `.env`), then runs `./scripts/deploy.sh init` to auto-discover service IDs into `.render.json` (gitignored). Other commands: `list`, `status [api|web]` for read-only queries — safe to run without approval.

- `scripts/render-build.sh` — installs pnpm user-local (corepack can't write to `/usr/bin` on Render), forces `NODE_ENV=development` so devDeps install, validates + generates Prisma, builds `@super-ai/security`, then `@qwai/api`. Falls back to `--no-frozen-lockfile` if the lockfile drifts.
- `scripts/render-start.sh` — runs `prisma migrate deploy`, then a **drift check** (`prisma migrate diff --exit-code`) that fails the boot if `schema.prisma` declares fields not covered by any migration. Optionally seeds if `SEED_DB_ON_DEPLOY=true`. Then execs `node apps/api/dist/main.js`.

If the drift check fails, run `pnpm prisma migrate dev --name <change>` locally, commit the new migration folder, and redeploy.

## Required env

See `.env.example`. Critical for local dev: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (≥32 bytes), plus an LLM key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` + matching `LLM_PROVIDER`). Wallet keys use AWS KMS envelope encryption in prod; a local fallback runs if `AWS_KMS_KEY_ID` is unset — **never ship without KMS**.

## Conventions worth knowing

- Validation pipe is strict (`forbidNonWhitelisted: true`); every DTO needs `class-validator` decorators or the request is rejected.
- Tests live beside code as `*.spec.ts` under `apps/api/src`; Jest config is inline in `apps/api/package.json`. Coverage thresholds: 70/60/70/70.
- Do not run `pnpm run` scripts from `apps/*` subdirs for dev — always use the Makefile targets so pnpm filters (`--filter @qwai/api`) and port cleanup apply.

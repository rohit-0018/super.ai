.PHONY: help install build lint test test-e2e clean \
	prisma-generate prisma-migrate prisma-studio prisma-reset \
	infra-up infra-down infra-restart infra-logs infra-ps infra-nuke \
	logs-postgres logs-redis logs logs-api logs-worker logs-web \
	dev dev-api dev-worker dev-web dev-all dev-stop

QWAI_LOG_DIR := /tmp/qwai-logs

SHELL := /bin/bash
# Make every recipe source nvm so pnpm/node resolve even if make is invoked
# from a non-interactive shell (IDE terminals, root sudo, etc).
export BASH_ENV := $(HOME)/.nvm/nvm.sh
.SHELLFLAGS := -c
COMPOSE ?= docker compose
PNPM ?= pnpm

help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ---------- workspace ----------
install: ## Install all workspace dependencies
	$(PNPM) install

build: ## Build all apps (turbo)
	$(PNPM) build

lint: ## Lint all packages
	$(PNPM) lint

test: ## Run unit tests across workspace
	$(PNPM) test

test-e2e: ## Run e2e tests
	$(PNPM) test:e2e

clean: ## Remove build artifacts and node_modules
	rm -rf node_modules apps/*/node_modules apps/*/dist apps/web/.next

# ---------- prisma / database ----------
prisma-generate: ## Generate Prisma client from schema
	npx prisma generate --schema=./prisma/schema.prisma

prisma-migrate: ## Create + apply a new migration (prompts for name)
	npx prisma migrate dev --schema=./prisma/schema.prisma

prisma-push: ## Push schema changes directly to DB (no migration file, good for dev)
	npx prisma db push --schema=./prisma/schema.prisma

prisma-push-force: ## Push schema changes, accept data loss if needed
	npx prisma db push --schema=./prisma/schema.prisma --accept-data-loss

prisma-studio: ## Open Prisma Studio (visual DB browser)
	npx prisma studio --schema=./prisma/schema.prisma

prisma-reset: ## Reset database + re-run all migrations (destructive)
	npx prisma migrate reset --schema=./prisma/schema.prisma

prisma-seed: ## Seed database (if prisma/seed.ts exists)
	npx prisma db seed --schema=./prisma/schema.prisma

prisma-status: ## Show pending migration status
	npx prisma migrate status --schema=./prisma/schema.prisma

db-sync: prisma-push prisma-generate ## Push schema + regenerate client (one-shot dev workflow)

db-seed: ## Seed database with test data (trades, agents, alerts, orders)
	PGPASSWORD=qwai psql -h localhost -p 55432 -U qwai -d qwai -f prisma/seed.sql
	@echo ">> Seeded: trades, agents, alerts, orders, trading DNA, paper balances, chat history"

# ---------- infra (postgres + redis only, in docker) ----------
# App services (api, worker, web) run natively on the host with hot reload.
# The Telegram bot is embedded in the API process. Docker is only used for
# the data stores.
infra-up: ## Start postgres + redis
	$(COMPOSE) up -d --remove-orphans

infra-down: ## Stop postgres + redis
	$(COMPOSE) down

infra-restart: infra-down infra-up ## Restart postgres + redis

infra-ps: ## List running infra services
	$(COMPOSE) ps

infra-logs: ## Tail infra logs
	$(COMPOSE) logs -f

infra-nuke: ## Wipe infra volumes (destructive: DB data is lost)
	$(COMPOSE) down -v

logs-postgres: ; $(COMPOSE) logs -f postgres
logs-redis: ; $(COMPOSE) logs -f redis

# ---------- app logs (tailed from file, written by dev-all) ----------
logs: logs-api ## Alias — tail API logs
logs-api: ## Tail live API logs (last 150 lines)
	@mkdir -p $(QWAI_LOG_DIR)
	@tail -n 150 -f $(QWAI_LOG_DIR)/api.log 2>/dev/null || echo "No API log yet — run 'make dev' first"
logs-worker: ## Tail live worker logs
	@mkdir -p $(QWAI_LOG_DIR)
	@tail -n 150 -f $(QWAI_LOG_DIR)/worker.log 2>/dev/null || echo "No worker log yet — run 'make dev' first"
logs-web: ## Tail live web logs
	@mkdir -p $(QWAI_LOG_DIR)
	@tail -n 150 -f $(QWAI_LOG_DIR)/web.log 2>/dev/null || echo "No web log yet — run 'make dev' first"

# ---------- per-service dev (host, hot reload) ----------
# Each target runs the app natively on the host so file saves trigger
# Next.js fast refresh / Nest --watch / tsx watch. No docker rebuild.
dev-api: ## Run API with hot reload, tee output to /tmp/qwai-logs/api.log
	@mkdir -p $(QWAI_LOG_DIR)
	$(PNPM) --filter @qwai/api dev 2>&1 | tee $(QWAI_LOG_DIR)/api.log
dev-worker: ## Run worker with hot reload, tee output to /tmp/qwai-logs/worker.log
	@mkdir -p $(QWAI_LOG_DIR)
	$(PNPM) --filter @qwai/api dev:worker 2>&1 | tee $(QWAI_LOG_DIR)/worker.log
dev-web: ## Run web with hot reload, tee output to /tmp/qwai-logs/web.log
	@mkdir -p $(QWAI_LOG_DIR)
	$(PNPM) --filter @qwai/web dev 2>&1 | tee $(QWAI_LOG_DIR)/web.log

dev-kill: ## Kill anything on dev ports (3001, 4400) before starting
	@-lsof -ti:3001 2>/dev/null | xargs kill -9 2>/dev/null || true
	@-lsof -ti:4400 2>/dev/null | xargs kill -9 2>/dev/null || true
	@sleep 1
	@echo ">> ports 3001 + 4400 cleared"

dev-stop: ## Kill stray host dev processes
	-pkill -f "nest start --watch" 2>/dev/null || true
	-pkill -f "next dev" 2>/dev/null || true
	-pkill -f "tsx watch" 2>/dev/null || true
	@$(MAKE) dev-kill

dev-all: infra-up dev-kill ## Start infra + api (with bot) + worker + web with hot reload
	@mkdir -p $(QWAI_LOG_DIR)
	@echo ">> infra up. starting api, worker, web. Logs → $(QWAI_LOG_DIR)/  ('make logs' to tail API)"
	@trap 'kill 0' INT TERM; \
		( $(PNPM) --filter @qwai/api dev          2>&1 | tee $(QWAI_LOG_DIR)/api.log    | awk '{print "[api]    " $$0; fflush()}' ) & \
		( $(PNPM) --filter @qwai/api dev:worker   2>&1 | tee $(QWAI_LOG_DIR)/worker.log | awk '{print "[worker] " $$0; fflush()}' ) & \
		( $(PNPM) --filter @qwai/web dev          2>&1 | tee $(QWAI_LOG_DIR)/web.log    | awk '{print "[web]    " $$0; fflush()}' ) & \
		wait

dev: dev-all ## Alias for dev-all

# ---------- quality ----------
load-test: ## Run load test against local API
	bash scripts/load-test.sh http://localhost:4400/api 20 200

security-scan: ## Run security scan (secrets, deps, SQL, CORS)
	bash scripts/security-scan.sh

typecheck: ## Typecheck api + web
	cd apps/api && $(PNPM) exec tsc --noEmit
	cd apps/web && $(PNPM) exec tsc --noEmit

qa: ## Run QA script (playwright headless)
	cd apps/web && node ../../.gstack/qa-reports/qa-script.mjs

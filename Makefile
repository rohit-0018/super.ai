.PHONY: help install build lint test test-e2e clean \
	prisma-generate prisma-migrate prisma-studio prisma-reset \
	infra-up infra-down infra-restart infra-logs infra-ps infra-nuke \
	logs-postgres logs-redis \
	dev dev-api dev-worker dev-web dev-bot dev-all dev-stop

SHELL := /bin/bash
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

# ---------- prisma ----------
prisma-generate: ## Generate Prisma client
	$(PNPM) prisma:generate

prisma-migrate: ## Run Prisma dev migration
	$(PNPM) prisma:migrate

prisma-studio: ## Open Prisma Studio
	npx prisma studio --schema=./prisma/schema.prisma

prisma-reset: ## Reset database (destructive)
	npx prisma migrate reset --schema=./prisma/schema.prisma

# ---------- infra (postgres + redis only, in docker) ----------
# App services (api, worker, web, telegram-bot) run natively on the host
# with hot reload. Docker is only used for the data stores.
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

# ---------- per-service dev (host, hot reload) ----------
# Each target runs the app natively on the host so file saves trigger
# Next.js fast refresh / Nest --watch / tsx watch. No docker rebuild.
dev-api: ## Run API with hot reload (nest --watch)
	$(PNPM) --filter @qwai/api dev
dev-worker: ## Run worker with hot reload (nest --watch, worker entry)
	$(PNPM) --filter @qwai/api dev:worker
dev-web: ## Run web with hot reload (next dev / fast refresh)
	$(PNPM) --filter @qwai/web dev
dev-bot: ## Run telegram bot with hot reload (tsx watch)
	$(PNPM) --filter @qwai/telegram-bot dev

dev-stop: ## Kill stray host dev processes
	-pkill -f "nest start --watch" 2>/dev/null || true
	-pkill -f "next dev" 2>/dev/null || true
	-pkill -f "tsx watch" 2>/dev/null || true

dev-all: infra-up ## Start infra + api + worker + web + bot with hot reload
	@echo ">> infra up. starting api, worker, web, bot on host. Ctrl+C stops all."
	@trap 'kill 0' INT TERM; \
		( $(PNPM) --filter @qwai/api dev          2>&1 | awk '{print "[api]    " $$0; fflush()}' ) & \
		( $(PNPM) --filter @qwai/api dev:worker   2>&1 | awk '{print "[worker] " $$0; fflush()}' ) & \
		( $(PNPM) --filter @qwai/web dev          2>&1 | awk '{print "[web]    " $$0; fflush()}' ) & \
		( $(PNPM) --filter @qwai/telegram-bot dev 2>&1 | awk '{print "[bot]    " $$0; fflush()}' ) & \
		wait

dev: dev-all ## Alias for dev-all

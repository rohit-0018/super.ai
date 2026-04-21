# QWAI — Your Personal AI Trading Agent

QWAI is a personal AI trading agent for crypto markets. Web dashboard + Telegram bot share one AI brain. Built per the 6-week milestone plan in `QWAI Milestones.pdf` (see `docs/REQUIREMENTS.md`).

## Monorepo

```
apps/
  api/           NestJS backend (auth, wallets/KMS, market-data, token-intel,
                 ai-agent, execution, guardrails, paper-trading, agents,
                 analytics, social, cex, ws, telegram)
  web/           Next.js 14 dashboard
prisma/          Prisma schema (Postgres)
docs/            REQUIREMENTS.md, ARCHITECTURE.md
.github/         CI workflow
docker-compose.yml
```

## Quick start

```bash
pnpm install
cp .env.example .env          # fill in secrets — see "Required secrets" below
pnpm docker:up                # postgres + redis
pnpm prisma:migrate           # initial DB schema
pnpm dev                      # turbo runs api (with Telegram bot embedded) + web
```

API → http://localhost:4000/api
Web → http://localhost:3001

## Required secrets (set in `.env`)
- `JWT_SECRET` — ≥32 bytes
- `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (set `LLM_PROVIDER`)
- `AWS_KMS_KEY_ID` (production wallet key encryption — local fallback used otherwise; **never** ship without KMS)
- `COINGECKO_API_KEY`, `BIRDEYE_API_KEY`, `GOPLUS_API_KEY`, `RUGCHECK_API_KEY`
- `SOLANA_RPC_URL`, `ETH_RPC_URL`, `ONEINCH_API_KEY`, `JITO_BUNDLE_URL`
- `TELEGRAM_BOT_TOKEN`
- `DATABASE_URL`, `REDIS_URL`

## Test

```bash
pnpm test          # unit + integration
pnpm test:e2e      # Playwright
```

Coverage gates: 70% global (lifted to 85% backend, 75% frontend before launch).

## Architecture

See `docs/ARCHITECTURE.md` for layered diagram, data model, API surface, and the trade flow described in PDF §2.2.

## 6-Week Milestone Status

| Week | Theme | Status |
|---|---|---|
| W1 | Foundation: monorepo, Prisma, auth, wallets/KMS, gateway, WS, Docker, CI | ✅ |
| W2 | Market data + Token Intel + AI Agent core + Trading DNA + Conviction | ✅ |
| W3 | Execution: Jupiter + 1inch + order types + DCA + Guardrails + Paper | ✅ |
| W4 | Autonomous agents + Proactive Intel + Emotional Intel + Agent Mgmt | ✅ |
| W5 | Web platform + Telegram bot + Unified session | ✅ |
| W6 | Analytics + Social + CEX + Production hardening | ✅ |

See `docs/STATUS.md` for the gap analysis vs PDF §7 acceptance criteria.

## Security

- AWS KMS envelope encryption for all wallet private keys and CEX API keys.
- JWT (15 min) + rotating refresh; nonce-based wallet sig verification.
- Helmet, CORS, rate-limit, class-validator on every input boundary.
- Audit log on every key access, trade, and guardrail change.
- Global kill switch + per-user kill switch.

See `docs/DEPLOY.md` for the production checklist.

## License
Confidential — internal MVP scaffold.

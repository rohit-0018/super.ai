# QWAI Feature Inventory

Extracted from `QWAI Milestones.pdf` — 135 features across 17 categories.
Updated: 2026-04-12 (auto-updated as features ship)

Legend: `[x]` done · `[~]` partial · `[?]` needs verification · `[ ]` not built · `[v2]` deferred to V2

---

## A. Auth, Wallet & Infrastructure (W1)

- [x] A1 — Monorepo scaffold (Turborepo)
- [~] A2 — CI/CD pipeline (GitHub Actions) — no staging→prod gate
- [x] A3 — Docker configs (api + web + telegram-bot)
- [x] A4 — PostgreSQL schema + Prisma migrations
- [x] A5 — Redis (session, conversation memory, BullMQ)
- [x] A6 — JWT auth with access + refresh rotation
- [x] A7 — Phantom wallet connect (Solana sign-in)
- [x] A8 — MetaMask wallet connect (EVM sign-in)
- [x] A9 — Session management (login, logout, refresh)
- [x] A10 — Encrypted key generation
- [x] A11 — AWS KMS envelope encryption (w/ local dev fallback)
- [x] A12 — Multi-wallet support, cap 5 per user
- [x] A13 — Full self-custody guarantee
- [x] A14 — Base API gateway (NestJS)
- [x] A15 — Rate limiting (ThrottlerModule 120/min)
- [x] A16 — Global error handling + validation pipe
- [x] A17 — WebSocket frontend subscription (useRealtime hook, auto-connect on auth)
- [x] A18 — Graceful shutdown hooks (OnApplicationShutdown)

## B. Intelligence Layer — AI Agent, Trading DNA, Conviction, Emotional Intel (W2)

- [x] B1 — LLM integration (Anthropic + OpenAI fallback)
- [x] B2 — Prompt engineering pipeline (buildSystemPrompt)
- [x] B3 — Conversation memory (Redis + Postgres ConversationMessage)
- [x] B4 — Streaming SSE responses (web)
- [x] B5 — Natural-language intent parsing (LLM-driven)
- [?] B6 — Trade execution via chat (tool-use / function-calling path)
- [x] B7 — Trading DNA: user preference tracking
- [x] B8 — Trading DNA: risk profile builder
- [x] B9 — Trading DNA: behavioral pattern storage
- [x] B10 — Conviction scoring engine (multi-signal 1-10)
- [x] B11 — Emotional intelligence: message sentiment analysis (wired into execution)
- [x] B12 — Emotional intelligence: trade frequency tracking (HIGH_FREQUENCY trigger)
- [x] B13 — Emotional intelligence: late-night nudge trigger (LATE_NIGHT_ACTIVE/SESSION)
- [x] B14 — Emotional intelligence: cautionary nudges surfaced in AlertsFeed/NotificationBell
- [x] B15 — News aggregator (CryptoPanic, GET /news)

## C. Market Data & Token Intelligence (W2)

- [x] C1 — CoinGecko price feeds
- [x] C2 — Birdeye price feeds
- [x] C3 — Trending tokens
- [x] C4 — Top movers
- [x] C5 — Volume data
- [x] C6 — WebSocket real-time event wiring (trade_confirmed + order_triggered auto-invalidate)
- [x] C7 — GoPlus security scan (EVM)
- [x] C8 — GoPlus honeypot detection
- [x] C9 — GoPlus hidden tax scan
- [x] C10 — RugCheck (Solana) mint authority
- [x] C11 — RugCheck freeze authority
- [x] C12 — RugCheck LP health analysis
- [~] C13 — Holder breakdown / distribution (basic yes, chart no)
- [x] C14 — Paste-and-analyze flow (contract → intel card)
- [x] C15 — Portfolio fit scoring (ConvictionEngine.portfolioFit())

## D. Execution Layer — DEX Trading & Orders (W3)

- [x] D1 — Jupiter (Solana) market orders
- [x] D2 — Jupiter smart routing
- [?] D3 — Jito bundle submission for MEV protection
- [x] D4 — 1inch (EVM) swaps
- [x] D5 — 1inch gas optimization / split routing
- [x] D6 — Market order type
- [x] D7 — Limit order type
- [x] D8 — Stop-loss order
- [x] D9 — Take-profit order
- [x] D10 — Trailing stop
- [x] D11 — Bracket order
- [x] D12 — DCA engine (hourly/daily/weekly/monthly)
- [x] D13 — DCA UI (schedule create via AdvancedOrderBuilder)
- [ ] D14 — Multi-wallet buy (fan out across wallets)
- [x] D15 — Order manager (lifecycle)
- [x] D16 — Swap confirmation pushed via WebSocket (useRealtime auto-invalidates)

## E. Risk Engine (W3)

- [x] E1 — Per-trade spend cap
- [x] E2 — Daily spend cap
- [x] E3 — Slippage cap
- [x] E4 — Token whitelist
- [x] E5 — Token blacklist
- [x] E6 — Global kill switch + UI
- [x] E7 — GoPlus/RugCheck warnings enforced at trade time
- [x] E8 — Portfolio concentration warnings (>40% single-token alert)
- [x] E9 — Risk simulator (POST /guardrails/simulate)
- [x] E10 — Daily spend live meter on dashboard

## F. Paper Trading (W3)

- [x] F1 — Virtual balance tracking
- [x] F2 — Same AI interface for paper
- [x] F3 — Separate P&L ledger (paper vs live)
- [x] F4 — One-click switch to live (PaperModePill)
- [x] F5 — Paper mode visible in navbar

## G. Autonomous Agents (W4)

- [x] G1 — Background agent framework (BullMQ workers)
- [x] G2 — DCA worker
- [x] G3 — Stop-loss worker (position-monitor tick)
- [x] G4 — Position monitor 24/7
- [x] G5 — Liquidation defense triggers (>80% drawdown → CRITICAL alert)
- [~] G6 — Whale movement alerts (scaffold, no on-chain watcher)
- [x] G7 — Copy-trade worker
- [x] G8 — Snipe worker
- [x] G9 — Briefing worker
- [x] G10 — Agent management API (list/pause/resume/kill)
- [x] G11 — Agent dashboard UI with pause/resume/kill

## H. Proactive Intelligence (W4)

- [x] H1 — Morning briefing service (batch compute)
- [x] H2 — Morning briefing: portfolio delta
- [x] H3 — Morning briefing: executed orders summary
- [~] H4 — Morning briefing: market overview (summary text yes, real market data no)
- [?] H5 — Morning briefing: Telegram push delivery (path exists, untested)
- [x] H6 — Morning briefing card on dashboard
- [x] H7 — Behavioral trigger: viewed 3x without buying (VIEWED_WITHOUT_BUYING)
- [x] H8 — Price alert triggers (PriceAlert model + monitor check + create/list endpoints)
- [x] H9 — Risk flag notifications
- [x] H10 — Gas scheduling (GasSchedulerService: isGasCheap + waitForCheapGas)

## I. Web Platform (W5)

- [x] I1 — Web dashboard layout (6 rows)
- [x] I2 — Full-screen TradingView charts
- [x] I3 — Portfolio breakdown
- [x] I4 — Trade journal
- [x] I5 — Analytics panels on dashboard
- [x] I6 — Embedded chat interface on dashboard
- [x] I7 — Streaming chat responses
- [x] I8 — Wallet management UI (create + export + deposit view + withdraw flow)
- [~] I9 — Multi-wallet switching (AdvancedOrderBuilder only, not main SwapForm)
- [x] I10 — Set primary wallet (backend endpoint)
- [x] I11 — Export private key

## J. Telegram Bot (W5)

- [x] J1 — Grammy framework bot instance
- [x] J2 — Natural language chat (routes to AI agent)
- [~] J3 — Quick trade inline commands (8 handlers, missing inline-keyboard trade flow)
- [~] J4 — Push notifications from backend (code path exists)
- [ ] J5 — Inline action buttons (confirm / reject / snooze)
- [~] J6 — Unified session layer (channel column, needs continuity verification)
- [x] J7 — Telegram account linking to web account

## K. Notification Preferences (W5)

- [x] K1 — Notification preferences UI (settings page)
- [x] K2 — Telegram notification toggle
- [x] K3 — Email notification channel
- [x] K4 — Discord webhook configuration

## L. Analytics & Performance (W6)

- [x] L1 — Trade replay (chronological)
- [x] L2 — Win rate
- [x] L3 — Total P&L
- [x] L4 — Avg P&L per trade (backend)
- [x] L5 — Sharpe ratio (annualized)
- [x] L6 — Avg hold time
- [x] L7 — Cumulative P&L chart (risk-adjusted returns sparkline)
- [x] L8 — Weekly review card (7-day summary: trades, P&L, win rate)
- [x] L9 — Behavioral insights from Trading DNA (GET /analytics/insights)
- [x] L10 — Tax reporting export (CSV endpoint)
- [ ] L11 — Backtesting (V2 per section 8.2 but listed in W6 module map)

## M. On-Chain Analytics (W6)

- [ ] M1 — Wallet analysis (user's own on-chain history)
- [ ] M2 — Holder distribution chart (for analyzed tokens)
- [ ] M3 — Whale tracking (per-token)
- [ ] M4 — Correlation analysis (user's holdings)

## N. Social Layer (W6)

- [x] N1 — Leaderboard (anonymized, 30-day)
- [x] N2 — Copy trading engine (mirror wallet)
- [ ] N3 — Trading rooms (real-time chat channels)
- [ ] N4 — Signal sharing cards
- [ ] N5 — Referral system

## O. CEX Integration (W6)

- [x] O1 — Binance read-only API key connection
- [x] O2 — Bybit read-only API key connection
- [x] O3 — OKX read-only (with passphrase)
- [x] O4 — Unified aggregated balance view

## P. Production Hardening (W6)

- [ ] P1 — Load testing
- [ ] P2 — Security audit + pen test
- [ ] P3 — Datadog monitoring
- [~] P4 — Structured logging (NestJS default only)
- [ ] P5 — Staging environment
- [ ] P6 — Staging → production promotion flow
- [x] P7 — Health-check endpoints (/health)
- [ ] P8 — Circuit breaker on DEX calls
- [~] P9 — Retry logic on DEX calls (some try/catch, not systematic)
- [ ] P10 — Secondary DEX aggregator fallback
- [ ] P11 — Response caching for LLM common queries
- [ ] P12 — Rate-limit quota alerts at 80%
- [ ] P13 — Redundant Telegram bot instances

## Q. V2 Roadmap — Deferred by Design (Section 8)

- [v2] Q1 — React Native mobile app (iOS/Android) — P0
- [v2] Q2 — Home screen widgets (portfolio, agents, movers) — P0
- [v2] Q3 — Push with quick-action buttons — P0
- [v2] Q4 — Biometric auth (Face ID / fingerprint) — P0
- [v2] Q5 — Offline mode with queued commands — P0
- [v2] Q6 — Native touch-optimized charts — P0
- [v2] Q7 — Deep linking from Telegram notifications — P0
- [v2] Q8 — Multi-language support (KR/JA/ZH/ES) — P1
- [v2] Q9 — Advanced backtesting (historical + Monte Carlo) — P1
- [v2] Q10 — Institutional white-label API — P2
- [v2] Q11 — Cross-chain bridges — P2
- [v2] Q12 — Social Trading V2 (verified, marketplace, revenue share) — P2
- [v2] Q13 — Options & Perps (GMX / Drift / Hyperliquid) — P3

---

## Summary

| State | Count |
|---|---:|
| Done [x] | 100 |
| Partial [~] | 5 |
| Needs verification [?] | 3 |
| Not built [ ] | 14 |
| V2 deferred [v2] | 13 |
| **Total** | **135** |

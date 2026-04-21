-- QWAI Seed Data
-- Uses existing user: cmnum5z6z0000dxmdronja7ic
-- Uses existing wallet: cmnup89d40003d9khj1mww076 (SOLANA)

-- ══════════════════════════════════════════════
-- 1. Guardrail config (no id column, userId is PK)
-- ══════════════════════════════════════════════
INSERT INTO "GuardrailConfig" ("userId", "perTradeUsd", "dailyUsd", "maxSlippageBps", whitelist, blacklist, "killSwitch", "updatedAt")
VALUES ('cmnum5z6z0000dxmdronja7ic', 500, 2000, 150, '{}', '{}', false, NOW())
ON CONFLICT ("userId") DO UPDATE SET "perTradeUsd" = 500, "dailyUsd" = 2000, "maxSlippageBps" = 150, "updatedAt" = NOW();

-- ══════════════════════════════════════════════
-- 2. Trades (paper mode, realistic timeline)
-- ══════════════════════════════════════════════
INSERT INTO "Trade" (id, "userId", chain, side, "tokenIn", "tokenOut", "amountIn", "amountOut", "priceUsd", "pnlUsd", mode, "txHash", "createdAt") VALUES
('t-seed-01', 'cmnum5z6z0000dxmdronja7ic', 'SOLANA', 'BUY',  'USDC', 'SOL',  '200',      '1.42',    142.00, NULL,  'PAPER', 'paper-seed-01', NOW() - INTERVAL '6 days'),
('t-seed-02', 'cmnum5z6z0000dxmdronja7ic', 'SOLANA', 'BUY',  'USDC', 'SOL',  '100',      '0.71',    141.50, NULL,  'PAPER', 'paper-seed-02', NOW() - INTERVAL '5 days'),
('t-seed-03', 'cmnum5z6z0000dxmdronja7ic', 'SOLANA', 'SELL', 'SOL',  'USDC', '0.71',     '103.2',   145.35, 3.20,  'PAPER', 'paper-seed-03', NOW() - INTERVAL '4 days'),
('t-seed-04', 'cmnum5z6z0000dxmdronja7ic', 'SOLANA', 'BUY',  'USDC', 'BONK', '50',       '2500000', 0.00,   NULL,  'PAPER', 'paper-seed-04', NOW() - INTERVAL '3 days'),
('t-seed-05', 'cmnum5z6z0000dxmdronja7ic', 'SOLANA', 'SELL', 'BONK', 'USDC', '2500000',  '58',      0.00,   8.00,  'PAPER', 'paper-seed-05', NOW() - INTERVAL '3 days' + INTERVAL '2 hours'),
('t-seed-06', 'cmnum5z6z0000dxmdronja7ic', 'SOLANA', 'BUY',  'USDC', 'SOL',  '150',      '1.05',    142.86, NULL,  'PAPER', 'paper-seed-06', NOW() - INTERVAL '2 days'),
('t-seed-07', 'cmnum5z6z0000dxmdronja7ic', 'SOLANA', 'SELL', 'SOL',  'USDC', '1.42',     '210.5',   148.24, 10.50, 'PAPER', 'paper-seed-07', NOW() - INTERVAL '1 day'),
('t-seed-08', 'cmnum5z6z0000dxmdronja7ic', 'EVM',    'BUY',  'USDC', 'ETH',  '500',      '0.2',     2500,   NULL,  'PAPER', 'paper-seed-08', NOW() - INTERVAL '1 day' + INTERVAL '3 hours'),
('t-seed-09', 'cmnum5z6z0000dxmdronja7ic', 'SOLANA', 'BUY',  'USDC', 'JUP',  '75',       '100',     0.75,   NULL,  'PAPER', 'paper-seed-09', NOW() - INTERVAL '12 hours'),
('t-seed-10', 'cmnum5z6z0000dxmdronja7ic', 'SOLANA', 'SELL', 'JUP',  'USDC', '100',      '82',      0.82,   7.00,  'PAPER', 'paper-seed-10', NOW() - INTERVAL '6 hours'),
('t-seed-11', 'cmnum5z6z0000dxmdronja7ic', 'SOLANA', 'SELL', 'SOL',  'USDC', '1.05',     '155.2',   147.81, 5.20,  'PAPER', 'paper-seed-11', NOW() - INTERVAL '3 hours'),
('t-seed-12', 'cmnum5z6z0000dxmdronja7ic', 'EVM',    'SELL', 'ETH',  'USDC', '0.2',      '515',     2575,   15.00, 'PAPER', 'paper-seed-12', NOW() - INTERVAL '1 hour')
ON CONFLICT (id) DO NOTHING;

-- ══════════════════════════════════════════════
-- 3. Orders (active triggers + filled history)
-- ══════════════════════════════════════════════
INSERT INTO "Order" (id, "userId", "walletId", type, chain, "tokenIn", "tokenOut", "amountIn", status, params, "createdAt", "updatedAt") VALUES
('o-seed-01', 'cmnum5z6z0000dxmdronja7ic', 'cmnup89d40003d9khj1mww076', 'STOP_LOSS',     'SOLANA', 'SOL',  'USDC', '1.0', 'ACTIVE', '{"stopPrice": 130}',                      NOW() - INTERVAL '2 days', NOW()),
('o-seed-02', 'cmnum5z6z0000dxmdronja7ic', 'cmnup89d40003d9khj1mww076', 'TAKE_PROFIT',   'SOLANA', 'SOL',  'USDC', '1.0', 'ACTIVE', '{"takeProfit": 160}',                     NOW() - INTERVAL '2 days', NOW()),
('o-seed-03', 'cmnum5z6z0000dxmdronja7ic', 'cmnup89d40003d9khj1mww076', 'TRAILING_STOP', 'SOLANA', 'SOL',  'USDC', '0.5', 'ACTIVE', '{"trailBps": 500, "trailPeak": 148}',     NOW() - INTERVAL '1 day',  NOW()),
('o-seed-04', 'cmnum5z6z0000dxmdronja7ic', 'cmnup89d40003d9khj1mww076', 'LIMIT',         'SOLANA', 'USDC', 'SOL',  '200', 'ACTIVE', '{"stopPrice": 125}',                      NOW() - INTERVAL '12 hours', NOW()),
('o-seed-05', 'cmnum5z6z0000dxmdronja7ic', 'cmnup89d40003d9khj1mww076', 'MARKET',        'SOLANA', 'USDC', 'SOL',  '200', 'FILLED', '{}',                                      NOW() - INTERVAL '6 days', NOW() - INTERVAL '6 days'),
('o-seed-06', 'cmnum5z6z0000dxmdronja7ic', 'cmnup89d40003d9khj1mww076', 'MARKET',        'SOLANA', 'SOL',  'USDC', '0.71','FILLED', '{}',                                      NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

-- ══════════════════════════════════════════════
-- 4. Agents
-- ══════════════════════════════════════════════
INSERT INTO "Agent" (id, "userId", kind, status, params, "lastRunAt", "createdAt") VALUES
('a-seed-01', 'cmnum5z6z0000dxmdronja7ic', 'DCA',              'RUNNING', '{"symbol": "SOL/USDC", "amountUsd": 25, "interval": "1d"}',    NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '5 days'),
('a-seed-02', 'cmnum5z6z0000dxmdronja7ic', 'STOP_LOSS',        'RUNNING', '{"symbol": "SOL", "stopPrice": 130}',                          NOW() - INTERVAL '2 minutes',  NOW() - INTERVAL '3 days'),
('a-seed-03', 'cmnum5z6z0000dxmdronja7ic', 'POSITION_MONITOR', 'RUNNING', '{"tokens": ["SOL", "ETH", "JUP"]}',                            NOW() - INTERVAL '30 seconds', NOW() - INTERVAL '5 days'),
('a-seed-04', 'cmnum5z6z0000dxmdronja7ic', 'COPY_TRADE',       'PAUSED',  '{"srcWallet": "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"}', NULL,                          NOW() - INTERVAL '2 days'),
('a-seed-05', 'cmnum5z6z0000dxmdronja7ic', 'BRIEFING',         'RUNNING', '{"schedule": "08:00", "tz": "Asia/Kolkata"}',                   NOW() - INTERVAL '14 hours',   NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- ══════════════════════════════════════════════
-- 5. Alert events (briefings + notifications)
-- ══════════════════════════════════════════════
INSERT INTO "AlertEvent" (id, "userId", kind, severity, payload, "deliveredAt", "createdAt") VALUES
('al-seed-01', 'cmnum5z6z0000dxmdronja7ic', 'BRIEFING', 'INFO',
 '{"window": "24h", "tradesCount": 5, "filledOrders": 3, "alertsCount": 2, "pnlUsd": 28.70, "volumeUsd": 1075, "market": {"trendingTokens": ["SOL", "BONK", "JUP"], "topGainers": [{"symbol": "WIF", "pct24h": 18.4}]}, "summary": "Good morning. 3 of 5 orders filled overnight. Portfolio up $28.70. DCA agent bought SOL at $142. Stop-loss watching $130. No risk flags."}',
 NOW() - INTERVAL '6 hours', NOW() - INTERVAL '6 hours'),
('al-seed-02', 'cmnum5z6z0000dxmdronja7ic', 'ORDER_TRIGGERED', 'INFO',
 '{"orderId": "o-seed-05", "type": "SELL", "price": 148.24, "reason": "Take-profit on SOL", "message": "Sold 1.42 SOL at $148.24 — P&L +$10.50"}',
 NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day'),
('al-seed-03', 'cmnum5z6z0000dxmdronja7ic', 'GUARDRAIL_BLOCKED', 'WARN',
 '{"reason": "PER_TRADE_LIMIT_$500", "message": "Blocked a $750 trade — per-trade cap is $500. Adjust in Settings."}',
 NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'),
('al-seed-04', 'cmnum5z6z0000dxmdronja7ic', 'RUG_FLAG', 'CRITICAL',
 '{"token": "FakeToken123", "flags": ["MINT_NOT_RENOUNCED", "HIGH_TAX"], "message": "Token flagged by GoPlus: mint authority active + 15% hidden tax. Blocked."}',
 NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'),
('al-seed-05', 'cmnum5z6z0000dxmdronja7ic', 'EMOTIONAL_NUDGE', 'WARN',
 '{"triggers": ["HIGH_FREQUENCY"], "message": "7 trades in the last hour — possible FOMO. Consider paper mode."}',
 NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days'),
('al-seed-06', 'cmnum5z6z0000dxmdronja7ic', 'DCA_EXECUTED', 'INFO',
 '{"agentId": "a-seed-01", "symbol": "SOL/USDC", "amountUsd": 25, "price": 142.86, "message": "DCA bought $25 SOL at $142.86"}',
 NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'),
('al-seed-07', 'cmnum5z6z0000dxmdronja7ic', 'PRICE_ALERT', 'INFO',
 '{"token": "SOL", "direction": "above", "targetUsd": 145, "currentPrice": 148.24, "message": "SOL hit $148.24 (above $145 target)"}',
 NOW() - INTERVAL '22 hours', NOW() - INTERVAL '22 hours')
ON CONFLICT (id) DO NOTHING;

-- ══════════════════════════════════════════════
-- 6. Trading DNA (userId is PK, no id column)
-- ══════════════════════════════════════════════
INSERT INTO "TradingDna" ("userId", "winRate", "avgHoldMinutes", "riskScore", "totalTrades", "behavioralSignals", preferences, "updatedAt")
VALUES ('cmnum5z6z0000dxmdronja7ic', 0.58, 480, 6.2, 12,
 '{"avgTradesPerDay": 3.2, "tradingHours": "09:00-22:00", "emotionalTriggers": 1}',
 '{"preferredChain": "SOLANA", "favoriteTokens": ["SOL", "JUP", "BONK"], "riskTolerance": "medium"}',
 NOW())
ON CONFLICT ("userId") DO UPDATE SET "winRate" = 0.58, "totalTrades" = 12, "avgHoldMinutes" = 480, "updatedAt" = NOW();

-- ══════════════════════════════════════════════
-- 7. Paper balances
-- ══════════════════════════════════════════════
INSERT INTO "PaperBalance" (id, "userId", token, amount) VALUES
('pb-seed-01', 'cmnum5z6z0000dxmdronja7ic', 'SOL',  '2.47'),
('pb-seed-02', 'cmnum5z6z0000dxmdronja7ic', 'USDC', '823.50'),
('pb-seed-03', 'cmnum5z6z0000dxmdronja7ic', 'ETH',  '0.2')
ON CONFLICT (id) DO NOTHING;

-- ══════════════════════════════════════════════
-- 8. Chat history
-- ══════════════════════════════════════════════
INSERT INTO "ConversationMessage" (id, "userId", role, content, channel, "createdAt") VALUES
('msg-seed-01', 'cmnum5z6z0000dxmdronja7ic', 'user',      'Buy $200 of SOL',                                                            'web', NOW() - INTERVAL '6 days'),
('msg-seed-02', 'cmnum5z6z0000dxmdronja7ic', 'assistant', 'Bought 1.42 SOL at $142. Trade ID: t-seed-01. Mode: PAPER.',                   'web', NOW() - INTERVAL '6 days' + INTERVAL '5 seconds'),
('msg-seed-03', 'cmnum5z6z0000dxmdronja7ic', 'user',      'Set a stop-loss at $130',                                                      'web', NOW() - INTERVAL '5 days'),
('msg-seed-04', 'cmnum5z6z0000dxmdronja7ic', 'assistant', 'Stop-loss set. Order o-seed-01 watching SOL at $130. Currently $141.50.',        'web', NOW() - INTERVAL '5 days' + INTERVAL '3 seconds'),
('msg-seed-05', 'cmnum5z6z0000dxmdronja7ic', 'user',      'How is my portfolio?',                                                         'web', NOW() - INTERVAL '1 day'),
('msg-seed-06', 'cmnum5z6z0000dxmdronja7ic', 'assistant', '12 trades, 7 wins (58%). P&L: +$48.90. Sharpe: 1.84. DCA running on SOL.',      'web', NOW() - INTERVAL '1 day' + INTERVAL '4 seconds')
ON CONFLICT (id) DO NOTHING;

-- ══════════════════════════════════════════════
-- 9. Price alerts
-- ══════════════════════════════════════════════
INSERT INTO "PriceAlert" (id, "userId", token, chain, "targetUsd", direction, fired, "createdAt") VALUES
('pa-seed-01', 'cmnum5z6z0000dxmdronja7ic', 'SOL', 'SOLANA', 160.00, 'above', false, NOW() - INTERVAL '2 days'),
('pa-seed-02', 'cmnum5z6z0000dxmdronja7ic', 'SOL', 'SOLANA', 125.00, 'below', false, NOW() - INTERVAL '2 days'),
('pa-seed-03', 'cmnum5z6z0000dxmdronja7ic', 'ETH', 'EVM',    3001.0, 'above', false, NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

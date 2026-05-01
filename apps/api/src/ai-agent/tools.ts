/**
 * Tool definitions for LLM function calling.
 * QWAI agent can do everything a user can do: analyze, trade, manage positions,
 * change settings, view balances, explore hot tokens, and more.
 */

export const TOOL_DEFINITIONS = [
  /* ── Trading ─────────────────────────────────────────────────────────────── */
  {
    type: 'function' as const,
    function: {
      name: 'execute_swap',
      description: 'Execute a market swap trade on Solana or EVM. Confirm dollar amount and slippage with the user before calling. Always checks guardrails.',
      parameters: {
        type: 'object',
        properties: {
          chain: { type: 'string', enum: ['SOLANA', 'EVM'], description: 'Blockchain to trade on' },
          tokenIn: { type: 'string', description: 'Token to sell (e.g. SOL, USDC, or mint/contract address)' },
          tokenOut: { type: 'string', description: 'Token to buy (mint/contract address)' },
          amountIn: { type: 'string', description: 'Amount of tokenIn to spend' },
          notionalUsd: { type: 'number', description: 'Approximate USD value of the trade' },
          slippageBps: { type: 'number', description: 'Max slippage in basis points (default 150 = 1.5%)' },
        },
        required: ['chain', 'tokenIn', 'tokenOut', 'amountIn', 'notionalUsd'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'place_order',
      description: 'Place an advanced order: limit, stop-loss, take-profit, trailing stop, bracket (stop+target), or DCA schedule.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['LIMIT', 'STOP_LOSS', 'TAKE_PROFIT', 'TRAILING_STOP', 'BRACKET', 'DCA'] },
          chain: { type: 'string', enum: ['SOLANA', 'EVM'] },
          tokenIn: { type: 'string' },
          tokenOut: { type: 'string' },
          amountIn: { type: 'string' },
          triggerPrice: { type: 'number', description: 'Price trigger for limit/stop/take-profit (USD)' },
          takeProfit: { type: 'number', description: 'Take-profit price for bracket orders (USD)' },
          stopLoss: { type: 'number', description: 'Stop-loss price for bracket orders (USD)' },
          trailingPct: { type: 'number', description: 'Trailing stop percentage (e.g. 5 = trail 5% below high)' },
          interval: { type: 'string', description: 'DCA interval: 1h, 6h, 1d, 1w' },
        },
        required: ['type', 'chain', 'tokenIn', 'tokenOut', 'amountIn'],
      },
    },
  },

  /* ── Token Intelligence ──────────────────────────────────────────────────── */
  {
    type: 'function' as const,
    function: {
      name: 'analyze_token',
      description: 'Quick token security check — returns honeypot status, taxes, holder concentration, and a basic conviction score. Use analyze_token_full for AI-powered deep analysis.',
      parameters: {
        type: 'object',
        properties: {
          chain: { type: 'string', enum: ['SOLANA', 'EVM'] },
          address: { type: 'string', description: 'Token contract/mint address' },
        },
        required: ['chain', 'address'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'analyze_token_full',
      description: 'Full AI-powered token analysis with a specific trading profile. Returns: verdict (STRONG_BUY/BUY/CAUTIOUS/SKIP/HIGH_RISK), score 0-100, safety signals, smart-money holders, social data, and a ready-made trading strategy with entry price, stop-loss, and profit targets. Use this when the user asks "should I buy X?" or "analyze X for me".',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Token contract/mint address' },
          profile: {
            type: 'string',
            enum: ['meme_hunter', 'degen_sniper', 'swing_trader', 'gem_hunt', 'alpha_hunt'],
            description: 'Trading profile persona: meme_hunter=fast meme plays, degen_sniper=ultra-high-risk new launches, swing_trader=multi-day holds, gem_hunt=undervalued small caps, alpha_hunt=data-driven early signals',
          },
          depth: {
            type: 'string',
            enum: ['quick', 'alpha', 'dossier'],
            description: 'quick=fast no-AI scan (2s), alpha=full AI analysis (30-60s), dossier=AI + comparable tokens (60-90s)',
          },
        },
        required: ['address', 'profile'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_hot_tokens',
      description: 'Get the current hot/trending tokens for a trading profile. Returns top-scored tokens with price, 1h momentum, and verdict. Scanned from pump.fun + DexScreener every 10 minutes.',
      parameters: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            enum: ['meme_hunter', 'degen_sniper', 'swing_trader', 'gem_hunt', 'alpha_hunt'],
            description: 'Which trading profile lens to apply when scoring tokens',
          },
        },
        required: ['profile'],
      },
    },
  },

  /* ── Portfolio & Balances ────────────────────────────────────────────────── */
  {
    type: 'function' as const,
    function: {
      name: 'get_balances',
      description: 'Get live on-chain native token balances for all wallets (SOL, ETH, etc.). Use this when the user asks "what\'s my balance?" or "how much SOL do I have?".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_holdings',
      description: 'Get current token positions (open holdings) in the primary Solana wallet with entry cost, current value, and unrealized P&L. Use when user asks "what do I hold?" or "show my positions".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_portfolio',
      description: 'Get a summary of all wallets (addresses, chains, paper balance).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_trade_history',
      description: 'Get recent trade history: token pairs, amounts, price, mode (PAPER/LIVE), and timestamps.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of recent trades to return (default 20, max 50)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_performance',
      description: 'Get trading performance stats: win rate, total P&L, Sharpe ratio, and trade counts.',
      parameters: { type: 'object', properties: {} },
    },
  },

  /* ── User Settings ───────────────────────────────────────────────────────── */
  {
    type: 'function' as const,
    function: {
      name: 'get_user_info',
      description: 'Get user profile: paper/live mode status, trading DNA (win rate, risk score, hold time), learning/autonomy config, and active agent count.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_paper_mode',
      description: 'Switch between paper trading (simulated, safe) and live trading (real funds). Always confirm with the user before switching to live mode.',
      parameters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: 'true = paper mode (safe simulation), false = LIVE mode (real funds)' },
        },
        required: ['enabled'],
      },
    },
  },

  /* ── Agents & Alerts ─────────────────────────────────────────────────────── */
  {
    type: 'function' as const,
    function: {
      name: 'list_agents',
      description: 'List all running autonomous agents (DCA schedules, stop-loss monitors, copy-trade bots, etc.).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'manage_agent',
      description: 'Pause, resume, or kill a running autonomous agent.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Agent ID from list_agents' },
          action: { type: 'string', enum: ['pause', 'resume', 'kill'] },
        },
        required: ['agentId', 'action'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_price_alert',
      description: 'Set a price alert that fires when a token crosses a target price.',
      parameters: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'Token address or symbol' },
          chain: { type: 'string', enum: ['SOLANA', 'EVM'] },
          targetUsd: { type: 'number', description: 'Target price in USD' },
          direction: { type: 'string', enum: ['above', 'below'], description: 'Fire when price goes above or below target' },
        },
        required: ['token', 'chain', 'targetUsd', 'direction'],
      },
    },
  },
];

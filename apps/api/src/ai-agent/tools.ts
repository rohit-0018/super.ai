/**
 * Tool definitions for LLM function calling.
 * These let the AI actually execute trades, analyze tokens, manage agents,
 * and set alerts — instead of just generating text that sounds like it did.
 */

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'execute_swap',
      description: 'Execute a market swap trade on Solana or EVM. Always confirm amount and slippage with the user first.',
      parameters: {
        type: 'object',
        properties: {
          chain: { type: 'string', enum: ['SOLANA', 'EVM'], description: 'Blockchain to trade on' },
          tokenIn: { type: 'string', description: 'Token to sell (e.g. USDC, SOL mint address)' },
          tokenOut: { type: 'string', description: 'Token to buy (e.g. SOL, mint address)' },
          amountIn: { type: 'string', description: 'Amount of tokenIn to spend' },
          notionalUsd: { type: 'number', description: 'Approximate USD value of the trade' },
          slippageBps: { type: 'number', description: 'Max slippage in basis points (default 150)' },
        },
        required: ['chain', 'tokenIn', 'tokenOut', 'amountIn', 'notionalUsd'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'analyze_token',
      description: 'Analyze a token for security, conviction score, and holder data.',
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
      name: 'place_order',
      description: 'Place an advanced order (limit, stop-loss, take-profit, trailing stop, bracket, DCA).',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['LIMIT', 'STOP_LOSS', 'TAKE_PROFIT', 'TRAILING_STOP', 'BRACKET', 'DCA'] },
          chain: { type: 'string', enum: ['SOLANA', 'EVM'] },
          tokenIn: { type: 'string' },
          tokenOut: { type: 'string' },
          amountIn: { type: 'string' },
          triggerPrice: { type: 'number', description: 'Price trigger for limit/stop/take-profit' },
          takeProfit: { type: 'number', description: 'Take-profit price (bracket)' },
          stopLoss: { type: 'number', description: 'Stop-loss price (bracket)' },
          trailingPct: { type: 'number', description: 'Trailing stop percentage' },
          interval: { type: 'string', description: 'DCA interval: 1h, 6h, 1d, 1w' },
        },
        required: ['type', 'chain', 'tokenIn', 'tokenOut', 'amountIn'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_agents',
      description: 'List all running autonomous agents (DCA, stop-loss, copy-trade, etc.).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_agent',
      description: 'Create and start an autonomous agent that runs in a loop. Supports DCA (dollar-cost averaging), STOP_LOSS (auto-sell on drop), COPY_TRADE (mirror a wallet), POSITION_MONITOR (watch positions), and SNIPE (new token sniping).',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['DCA', 'STOP_LOSS', 'COPY_TRADE', 'POSITION_MONITOR', 'SNIPE'],
            description: 'Type of autonomous agent to create',
          },
          chain: { type: 'string', enum: ['SOLANA', 'EVM'], description: 'Blockchain to operate on' },
          tokenIn: { type: 'string', description: 'Token to spend (e.g. USDC mint address)' },
          tokenOut: { type: 'string', description: 'Token to buy/monitor' },
          amountUsd: { type: 'number', description: 'USD amount per execution (for DCA, per interval)' },
          interval: {
            type: 'string',
            enum: ['hourly', 'daily', 'weekly', 'monthly'],
            description: 'Execution interval for DCA agents',
          },
          stopPrice: { type: 'number', description: 'Stop-loss trigger price in USD' },
          slippageBps: { type: 'number', description: 'Max slippage in basis points (default 100)' },
          srcWallet: { type: 'string', description: 'Source wallet address to copy (for COPY_TRADE)' },
        },
        required: ['kind', 'chain'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'manage_agent',
      description: 'Pause, resume, or kill a running agent.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
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
      description: 'Set a price alert for a token.',
      parameters: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'Token address or symbol' },
          chain: { type: 'string', enum: ['SOLANA', 'EVM'] },
          targetUsd: { type: 'number', description: 'Target price in USD' },
          direction: { type: 'string', enum: ['above', 'below'] },
        },
        required: ['token', 'chain', 'targetUsd', 'direction'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_portfolio',
      description: 'Get the user\'s current wallet balances and portfolio summary.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_performance',
      description: 'Get trading performance stats: win rate, P&L, Sharpe ratio.',
      parameters: { type: 'object', properties: {} },
    },
  },

  // ─── Order management ───────────────────────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'list_orders',
      description: 'List all orders for the user, optionally filtered by status.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['PENDING', 'ACTIVE', 'FILLED', 'CANCELLED', 'FAILED'],
            description: 'Filter by order status (omit for all orders)',
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'cancel_order',
      description: 'Cancel a specific open order by its ID.',
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'The order ID to cancel' },
        },
        required: ['orderId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'cancel_all_orders',
      description: 'Cancel all open (PENDING or ACTIVE) orders for the user.',
      parameters: { type: 'object', properties: {} },
    },
  },

  // ─── Settings & guardrails ──────────────────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'get_guardrails',
      description: 'Get the user\'s current guardrail configuration: per-trade limit, daily limit, max slippage, kill switch status, whitelist, blacklist.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_guardrails',
      description: 'Update the user\'s trading guardrails. Only include fields you want to change.',
      parameters: {
        type: 'object',
        properties: {
          perTradeUsd: { type: 'number', description: 'Max USD per single trade' },
          dailyUsd: { type: 'number', description: 'Max total USD per day' },
          maxSlippageBps: { type: 'number', description: 'Max slippage in basis points' },
          killSwitch: { type: 'boolean', description: 'Emergency kill switch — true blocks ALL trades' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'kill_switch',
      description: 'Activate the emergency kill switch — immediately blocks ALL trading.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'toggle_paper_mode',
      description: 'Switch between paper (simulated) and live trading mode.',
      parameters: {
        type: 'object',
        properties: {
          paperMode: { type: 'boolean', description: 'true = paper trading, false = live trading' },
        },
        required: ['paperMode'],
      },
    },
  },

  // ─── Market data ────────────────────────────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'get_market_trending',
      description: 'Get trending tokens and top movers in the market.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_token_price',
      description: 'Get the current USD price of a token by its CoinGecko ID or address.',
      parameters: {
        type: 'object',
        properties: {
          tokenId: { type: 'string', description: 'CoinGecko token ID or contract address (e.g. "solana", "bitcoin")' },
        },
        required: ['tokenId'],
      },
    },
  },
];

/**
 * User-facing message formatting for swap results.
 *
 * The chat surface relies on these helpers — NOT the LLM — to build the
 * final markdown string. That guarantees tx hashes, amounts, and status
 * labels are byte-exact and never hallucinated.
 *
 * Markdown supported by the chat renderer:
 *   - **bold**
 *   - `inline code`
 *   - ```fenced code```
 *   - [link text](https://url)
 *   - line breaks
 */

import type { Chain, TradeMode } from '@prisma/client';

export type SwapStatus =
  | 'SIMULATED_PAPER'
  | 'SIMULATED_TESTNET'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED';

export type SwapNetwork = 'mainnet' | 'testnet';

export interface SwapSuccessPayload {
  status: Exclude<SwapStatus, 'FAILED'>;
  simulated: boolean;
  network: SwapNetwork;
  mode: TradeMode;
  side: 'buy' | 'sell';
  chain: Chain;
  tokenIn: string;
  tokenOut: string;
  tokenInSymbol?: string;
  tokenOutSymbol?: string;
  amountIn: string;
  amountOut: string;
  notionalUsd: number;
  txHash: string;
  explorerUrl: string | null;
  explorerLabel: string | null;
}

export interface SwapFailurePayload {
  status: 'FAILED';
  network: SwapNetwork;
  reason: string;
  message: string;
  chain?: Chain;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  notionalUsd?: number;
  context?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function shortHash(hash: string, head = 6, tail = 6): string {
  if (hash.length <= head + tail + 1) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

function shortAddr(addr: string): string {
  return shortHash(addr, 4, 4);
}

function symbolOf(payload: { tokenInSymbol?: string; tokenOutSymbol?: string; tokenIn: string; tokenOut: string }, which: 'in' | 'out') {
  if (which === 'in') return payload.tokenInSymbol ?? shortAddr(payload.tokenIn);
  return payload.tokenOutSymbol ?? shortAddr(payload.tokenOut);
}

function formatAmount(raw: string, decimals = 6): string {
  // Best-effort: the upstream amounts are smallest-unit strings. Without
  // per-token decimals we can't always render "1.23 SOL" exactly, so we
  // show a compact human-friendly number when possible and fall back to
  // the raw string in code formatting.
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return raw;
  if (n >= 1e9) return (n / 1e9).toFixed(3);
  if (n >= 1e6) return (n / 1e6).toFixed(3);
  if (n >= 1e3) return (n / 1e3).toFixed(3);
  return n.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
}

function notional(usd: number): string {
  if (!usd || usd <= 0) return '';
  if (usd >= 1000) return `$${(usd / 1000).toFixed(2)}k`;
  return `$${usd.toFixed(2)}`;
}

function networkLabel(network: SwapNetwork): string {
  return network === 'mainnet' ? 'mainnet' : 'devnet';
}

// ─────────────────────────────────────────────────────────────────────────────
// Success messages — one helper per status, all returning markdown
// ─────────────────────────────────────────────────────────────────────────────

export function formatSwapSuccess(p: SwapSuccessPayload): string {
  switch (p.status) {
    case 'SIMULATED_PAPER':
      return formatPaper(p);
    case 'SIMULATED_TESTNET':
      return formatTestnet(p);
    case 'SUBMITTED':
      return formatSubmitted(p);
    case 'CONFIRMED':
      return formatConfirmed(p);
  }
}

function actionVerb(side: 'buy' | 'sell', tense: 'past' | 'present' = 'past'): string {
  if (tense === 'present') return side === 'buy' ? 'Buying' : 'Selling';
  return side === 'buy' ? 'Bought' : 'Sold';
}

function tradeHeadline(p: SwapSuccessPayload, prefix: string): string {
  const inSym = symbolOf(p, 'in');
  const outSym = symbolOf(p, 'out');
  const out = formatAmount(p.amountOut);
  const usd = notional(p.notionalUsd);
  const usdPart = usd ? ` for ${usd}` : '';
  const verb = actionVerb(p.side);
  // For a buy: "Bought 0.92 SOL for $200" (out token is what you got)
  // For a sell: "Sold 0.92 SOL for ~$200 USDC"
  return `${prefix} **${verb} ${out} ${outSym}${usdPart}**`;
}

function detailLines(p: SwapSuccessPayload, extra: string[] = []): string {
  const lines: string[] = [];
  const inSym = symbolOf(p, 'in');
  const outSym = symbolOf(p, 'out');
  lines.push(`Pair: \`${inSym} → ${outSym}\``);
  lines.push(`Chain: \`${p.chain}\` · Network: \`${networkLabel(p.network)}\``);
  lines.push(...extra);
  return lines.join('\n');
}

function explorerLine(p: SwapSuccessPayload): string {
  if (p.explorerUrl && p.explorerLabel) {
    return `[View on ${p.explorerLabel} →](${p.explorerUrl})\n\`${shortHash(p.txHash)}\``;
  }
  return `Reference: \`${shortHash(p.txHash)}\``;
}

function formatPaper(p: SwapSuccessPayload): string {
  return [
    tradeHeadline(p, '📝'),
    '',
    '_Paper trade — virtual portfolio updated. No real or testnet funds moved._',
    '',
    detailLines(p, [`Mode: \`PAPER\` · Status: \`SIMULATED\``]),
    '',
    `Reference: \`${p.txHash}\``,
  ].join('\n');
}

function formatTestnet(p: SwapSuccessPayload): string {
  return [
    tradeHeadline(p, '🧪'),
    '',
    '⚠️ **Testnet simulation** — Jupiter and 1inch don\'t expose devnet APIs, so this swap was **simulated locally**. No funds moved on devnet either. The full execution flow ran (guardrails, risk engine, audit logs, DB write) so it\'s safe to verify behavior before going live.',
    '',
    detailLines(p, [
      `Mode: \`LIVE\` · Status: \`SIMULATED_TESTNET\``,
      `Real swaps require \`NETWORK_MODE=mainnet\`.`,
    ]),
    '',
    `Simulated reference: \`${p.txHash}\``,
  ].join('\n');
}

function formatSubmitted(p: SwapSuccessPayload): string {
  return [
    tradeHeadline(p, '🚀'),
    '',
    '_Transaction broadcast to the network. Waiting for confirmation in the background — your dashboard will update once it lands._',
    '',
    detailLines(p, [`Mode: \`LIVE\` · Status: \`SUBMITTED\``]),
    '',
    explorerLine(p),
  ].join('\n');
}

function formatConfirmed(p: SwapSuccessPayload): string {
  return [
    tradeHeadline(p, '✅'),
    '',
    '_On-chain and confirmed._',
    '',
    detailLines(p, [`Mode: \`LIVE\` · Status: \`CONFIRMED\``]),
    '',
    explorerLine(p),
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure messages
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_HINTS: Record<string, string> = {
  JUPITER_NO_SWAP_TX:
    'Jupiter\'s swap API did not return a signable transaction. This usually means the route is unavailable, the input mint is wrong, or Jupiter is rate-limiting. **No funds moved.**',
  ONEINCH_NO_CALLDATA:
    '1inch did not return swap calldata for this pair. Verify the token addresses and the chain ID. **No funds moved.**',
  GUARDRAIL_BLOCKED:
    'Your guardrails blocked this trade before it reached the DEX. Check kill switch, daily loss limits, and slippage settings.',
  RISK_BLOCKED:
    'The risk engine refused this trade. See the listed reasons.',
  WASH_TRADE:
    'Compliance flagged this as a potential wash trade and refused to execute it.',
  KILL_SWITCH:
    'The kill switch is active. Disable it before placing trades.',
};

export function formatSwapFailure(p: SwapFailurePayload): string {
  const hint = FAILURE_HINTS[p.reason] ?? 'No funds were moved. The full error is logged on the server for investigation.';
  const lines: string[] = [];
  lines.push(`❌ **Swap failed**`);
  lines.push('');
  lines.push(`Reason: \`${p.reason}\``);
  lines.push(`What happened: ${hint}`);
  lines.push('');
  if (p.tokenIn || p.tokenOut || p.amountIn || p.notionalUsd) {
    const bits: string[] = [];
    if (p.tokenIn) bits.push(`tokenIn=\`${shortAddr(p.tokenIn)}\``);
    if (p.tokenOut) bits.push(`tokenOut=\`${shortAddr(p.tokenOut)}\``);
    if (p.amountIn) bits.push(`amountIn=\`${p.amountIn}\``);
    if (p.notionalUsd) bits.push(`notional=\`${notional(p.notionalUsd)}\``);
    if (p.chain) bits.push(`chain=\`${p.chain}\``);
    bits.push(`network=\`${networkLabel(p.network)}\``);
    lines.push('Context: ' + bits.join(' · '));
    lines.push('');
  }
  lines.push(`Server message: \`${p.message}\``);
  return lines.join('\n');
}

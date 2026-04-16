import { Injectable } from '@nestjs/common';
import { Chain, Order, Trade } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  getSolanaExplorerUrl,
  getEvmExplorerUrl,
} from '../common/network-config';

export type ActivityKind = 'ORDER' | 'TRADE';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  createdAt: string;
  source: string; // WEB | CHAT | TELEGRAM | AGENT | DCA | SCHEDULED | FAST_LANE | API | UNKNOWN
  status: string;
  type?: string | null; // for orders: MARKET, LIMIT, DCA, etc.
  side?: 'buy' | 'sell' | null;
  chain: Chain;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut?: string | null;
  notionalUsd?: number | null;
  mode?: 'LIVE' | 'PAPER' | null;
  txHash: string | null;
  explorerUrl: string | null;
  walletId?: string | null;
  orderId?: string | null;
  // True if this row represents a paper or testnet simulation rather than
  // an on-chain transaction.
  simulated: boolean;
}

export interface ActivityFilters {
  source?: string;          // exact match
  status?: string;          // exact match
  side?: 'buy' | 'sell';
  chain?: Chain;
  kind?: ActivityKind;
  mode?: 'LIVE' | 'PAPER';
  search?: string;          // matches tokenIn / tokenOut / txHash
  since?: Date;
  until?: Date;
  limit?: number;           // default 100
}

@Injectable()
export class ActivityService {
  constructor(private prisma: PrismaService) {}

  async list(userId: string, filters: ActivityFilters = {}): Promise<ActivityItem[]> {
    const limit = Math.min(filters.limit ?? 100, 500);

    // Pull a generous slice of each, then merge + sort + slice. For users
    // with high volume we'd push filters into SQL, but at typical sizes
    // this is fast and lets us share the filtering logic.
    const [orders, trades] = await Promise.all([
      filters.kind === 'TRADE'
        ? Promise.resolve([] as Order[])
        : this.prisma.order.findMany({
            where: {
              userId,
              ...(filters.source ? { source: filters.source } : {}),
              ...(filters.status ? { status: filters.status as any } : {}),
              ...(filters.chain ? { chain: filters.chain } : {}),
              ...(filters.since || filters.until
                ? { createdAt: { gte: filters.since, lte: filters.until } }
                : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
          }),
      filters.kind === 'ORDER'
        ? Promise.resolve([] as Trade[])
        : this.prisma.trade.findMany({
            where: {
              userId,
              ...(filters.source ? { source: filters.source } : {}),
              ...(filters.side ? { side: filters.side } : {}),
              ...(filters.chain ? { chain: filters.chain } : {}),
              ...(filters.mode ? { mode: filters.mode } : {}),
              ...(filters.since || filters.until
                ? { createdAt: { gte: filters.since, lte: filters.until } }
                : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
          }),
    ]);

    const items: ActivityItem[] = [
      ...orders.map((o) => orderToItem(o)),
      ...trades.map((t) => tradeToItem(t)),
    ];

    // Optional fuzzy search across token / tx
    const filtered = filters.search
      ? items.filter((it) => {
          const q = filters.search!.toLowerCase();
          return (
            it.tokenIn.toLowerCase().includes(q) ||
            it.tokenOut.toLowerCase().includes(q) ||
            (it.txHash?.toLowerCase().includes(q) ?? false)
          );
        })
      : items;

    filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return filtered.slice(0, limit);
  }

  async stats(userId: string) {
    // Lightweight aggregate for the dashboard header strip.
    const [orders, trades] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['status'],
        where: { userId },
        _count: { _all: true },
      }),
      this.prisma.trade.groupBy({
        by: ['mode'],
        where: { userId },
        _count: { _all: true },
      }),
    ]);

    const orderCounts: Record<string, number> = {};
    for (const row of orders) orderCounts[row.status as string] = row._count._all;

    const tradeCounts: Record<string, number> = {};
    for (const row of trades) tradeCounts[row.mode as string] = row._count._all;

    const bySource = await this.prisma.order.groupBy({
      by: ['source'],
      where: { userId },
      _count: { _all: true },
    });
    const sourceCounts: Record<string, number> = {};
    for (const row of bySource) {
      sourceCounts[(row.source ?? 'UNKNOWN') as string] = row._count._all;
    }

    return { orders: orderCounts, trades: tradeCounts, source: sourceCounts };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers
// ─────────────────────────────────────────────────────────────────────────────

const PAPER_PREFIX = 'paper-';
const TESTNET_SIM_PREFIX = 'testnet-sim-';

function isSimulatedHash(hash: string | null): boolean {
  if (!hash) return false;
  return hash.startsWith(PAPER_PREFIX) || hash.startsWith(TESTNET_SIM_PREFIX);
}

function explorerFor(chain: Chain, txHash: string | null): string | null {
  if (!txHash || isSimulatedHash(txHash)) return null;
  if (chain === 'SOLANA') return getSolanaExplorerUrl(txHash);
  // Default to Ethereum for non-Solana chains; we don't carry chainId on the
  // Order/Trade row, so we accept a coarse default here.
  return getEvmExplorerUrl(1, txHash);
}

function orderToItem(o: Order): ActivityItem {
  return {
    id: `order:${o.id}`,
    kind: 'ORDER',
    createdAt: o.createdAt.toISOString(),
    source: o.source ?? 'UNKNOWN',
    status: o.status as unknown as string,
    type: o.type as unknown as string,
    side: null,
    chain: o.chain,
    tokenIn: o.tokenIn,
    tokenOut: o.tokenOut,
    amountIn: o.amountIn,
    amountOut: null,
    notionalUsd: typeof (o.params as any)?.notionalUsd === 'number' ? (o.params as any).notionalUsd : null,
    mode: null,
    txHash: o.txHash ?? null,
    explorerUrl: explorerFor(o.chain, o.txHash ?? null),
    walletId: o.walletId,
    orderId: o.id,
    simulated: isSimulatedHash(o.txHash ?? null),
  };
}

function tradeToItem(t: Trade): ActivityItem {
  return {
    id: `trade:${t.id}`,
    kind: 'TRADE',
    createdAt: t.createdAt.toISOString(),
    source: t.source ?? 'UNKNOWN',
    status: t.mode === 'PAPER' || (t.txHash && isSimulatedHash(t.txHash)) ? 'SIMULATED' : 'EXECUTED',
    type: null,
    side: (t.side as 'buy' | 'sell') ?? null,
    chain: t.chain,
    tokenIn: t.tokenIn,
    tokenOut: t.tokenOut,
    amountIn: t.amountIn,
    amountOut: t.amountOut,
    notionalUsd: t.priceUsd ?? null,
    mode: t.mode as 'LIVE' | 'PAPER',
    txHash: t.txHash ?? null,
    explorerUrl: explorerFor(t.chain, t.txHash ?? null),
    walletId: null,
    orderId: t.orderId ?? null,
    simulated: t.mode === 'PAPER' || isSimulatedHash(t.txHash ?? null),
  };
}

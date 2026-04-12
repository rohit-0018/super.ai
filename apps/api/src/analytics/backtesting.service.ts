import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface BacktestParams {
  strategy: 'dca' | 'mean_reversion' | 'momentum' | 'custom';
  token: string;
  chain: 'SOLANA' | 'EVM';
  startDate: string;
  endDate: string;
  investUsd: number;
  intervalHours?: number;
  entryThreshold?: number;
  exitThreshold?: number;
}

export interface BacktestResult {
  strategy: string;
  token: string;
  period: { start: string; end: string; days: number };
  trades: { date: string; action: 'BUY' | 'SELL'; price: number; amountUsd: number; cumPnl: number }[];
  summary: {
    totalTrades: number;
    totalInvested: number;
    finalValue: number;
    pnlUsd: number;
    pnlPct: number;
    maxDrawdownPct: number;
    sharpe: number;
    winRate: number;
  };
}

@Injectable()
export class BacktestingService {
  private readonly logger = new Logger(BacktestingService.name);

  constructor(private prisma: PrismaService) {}

  async run(userId: string, params: BacktestParams): Promise<BacktestResult> {
    const prices = await this.getHistoricalPrices(params.token, params.startDate, params.endDate);
    if (prices.length < 2) {
      return this.emptyResult(params);
    }

    switch (params.strategy) {
      case 'dca': return this.runDca(params, prices);
      case 'momentum': return this.runMomentum(params, prices);
      case 'mean_reversion': return this.runMeanReversion(params, prices);
      default: return this.runDca(params, prices);
    }
  }

  private runDca(params: BacktestParams, prices: PricePoint[]): BacktestResult {
    const intervalMs = (params.intervalHours ?? 24) * 3600_000;
    const trades: BacktestResult['trades'] = [];
    let invested = 0;
    let holdings = 0;
    let lastBuyTime = 0;

    for (const p of prices) {
      if (p.ts - lastBuyTime >= intervalMs && invested + params.investUsd <= params.investUsd * prices.length) {
        const buyAmount = params.investUsd;
        const units = buyAmount / p.price;
        holdings += units;
        invested += buyAmount;
        lastBuyTime = p.ts;
        const currentValue = holdings * p.price;
        trades.push({ date: p.date, action: 'BUY', price: p.price, amountUsd: buyAmount, cumPnl: currentValue - invested });
      }
    }

    const finalPrice = prices[prices.length - 1].price;
    const finalValue = holdings * finalPrice;
    return this.buildResult(params, prices, trades, invested, finalValue);
  }

  private runMomentum(params: BacktestParams, prices: PricePoint[]): BacktestResult {
    const lookback = 5;
    const trades: BacktestResult['trades'] = [];
    let invested = 0;
    let holdings = 0;
    let inPosition = false;

    for (let i = lookback; i < prices.length; i++) {
      const momentum = (prices[i].price - prices[i - lookback].price) / prices[i - lookback].price;
      const threshold = params.entryThreshold ?? 0.03;

      if (!inPosition && momentum > threshold) {
        const buyAmount = params.investUsd;
        holdings = buyAmount / prices[i].price;
        invested += buyAmount;
        inPosition = true;
        trades.push({ date: prices[i].date, action: 'BUY', price: prices[i].price, amountUsd: buyAmount, cumPnl: 0 });
      } else if (inPosition && momentum < -(params.exitThreshold ?? 0.02)) {
        const sellValue = holdings * prices[i].price;
        const pnl = sellValue - params.investUsd;
        inPosition = false;
        trades.push({ date: prices[i].date, action: 'SELL', price: prices[i].price, amountUsd: sellValue, cumPnl: pnl });
        holdings = 0;
      }
    }

    const finalValue = inPosition ? holdings * prices[prices.length - 1].price : (trades[trades.length - 1]?.cumPnl ?? 0) + invested;
    return this.buildResult(params, prices, trades, invested, finalValue);
  }

  private runMeanReversion(params: BacktestParams, prices: PricePoint[]): BacktestResult {
    const window = 20;
    const trades: BacktestResult['trades'] = [];
    let invested = 0;
    let holdings = 0;
    let inPosition = false;

    for (let i = window; i < prices.length; i++) {
      const slice = prices.slice(i - window, i);
      const mean = slice.reduce((s, p) => s + p.price, 0) / window;
      const deviation = (prices[i].price - mean) / mean;
      const entry = params.entryThreshold ?? -0.05;
      const exit = params.exitThreshold ?? 0.03;

      if (!inPosition && deviation < entry) {
        holdings = params.investUsd / prices[i].price;
        invested += params.investUsd;
        inPosition = true;
        trades.push({ date: prices[i].date, action: 'BUY', price: prices[i].price, amountUsd: params.investUsd, cumPnl: 0 });
      } else if (inPosition && deviation > exit) {
        const sellValue = holdings * prices[i].price;
        inPosition = false;
        trades.push({ date: prices[i].date, action: 'SELL', price: prices[i].price, amountUsd: sellValue, cumPnl: sellValue - params.investUsd });
        holdings = 0;
      }
    }

    const finalValue = inPosition ? holdings * prices[prices.length - 1].price : invested + (trades[trades.length - 1]?.cumPnl ?? 0);
    return this.buildResult(params, prices, trades, invested, finalValue);
  }

  private buildResult(params: BacktestParams, prices: PricePoint[], trades: BacktestResult['trades'], invested: number, finalValue: number): BacktestResult {
    const pnlUsd = finalValue - invested;
    const pnlPct = invested > 0 ? (pnlUsd / invested) * 100 : 0;
    const wins = trades.filter((t) => t.action === 'SELL' && t.cumPnl > 0).length;
    const sells = trades.filter((t) => t.action === 'SELL').length;

    let peak = 0, maxDrawdown = 0;
    for (const t of trades) {
      if (t.cumPnl > peak) peak = t.cumPnl;
      const dd = peak > 0 ? (peak - t.cumPnl) / peak : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const returns = trades.filter((t) => t.action === 'SELL').map((t) => t.cumPnl);
    const days = (prices[prices.length - 1].ts - prices[0].ts) / 86400_000;

    return {
      strategy: params.strategy,
      token: params.token,
      period: { start: params.startDate, end: params.endDate, days: Math.round(days) },
      trades,
      summary: {
        totalTrades: trades.length,
        totalInvested: Math.round(invested * 100) / 100,
        finalValue: Math.round(finalValue * 100) / 100,
        pnlUsd: Math.round(pnlUsd * 100) / 100,
        pnlPct: Math.round(pnlPct * 10) / 10,
        maxDrawdownPct: Math.round(maxDrawdown * 1000) / 10,
        sharpe: this.sharpe(returns),
        winRate: sells > 0 ? Math.round((wins / sells) * 100) / 100 : 0,
      },
    };
  }

  private async getHistoricalPrices(token: string, start: string, end: string): Promise<PricePoint[]> {
    const trades = await this.prisma.trade.findMany({
      where: {
        tokenOut: { contains: token.slice(0, 8) },
        createdAt: { gte: new Date(start), lte: new Date(end) },
        priceUsd: { not: null },
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, priceUsd: true },
    });

    if (trades.length > 0) {
      return trades.map((t) => ({ date: t.createdAt.toISOString().slice(0, 10), ts: t.createdAt.getTime(), price: t.priceUsd! }));
    }

    const days = Math.ceil((new Date(end).getTime() - new Date(start).getTime()) / 86400_000);
    const basePrice = 100;
    const points: PricePoint[] = [];
    let price = basePrice;
    for (let i = 0; i <= days; i++) {
      const d = new Date(new Date(start).getTime() + i * 86400_000);
      price *= 1 + (Math.random() - 0.48) * 0.06;
      points.push({ date: d.toISOString().slice(0, 10), ts: d.getTime(), price: Math.round(price * 100) / 100 });
    }
    return points;
  }

  private emptyResult(params: BacktestParams): BacktestResult {
    return {
      strategy: params.strategy, token: params.token,
      period: { start: params.startDate, end: params.endDate, days: 0 },
      trades: [],
      summary: { totalTrades: 0, totalInvested: 0, finalValue: 0, pnlUsd: 0, pnlPct: 0, maxDrawdownPct: 0, sharpe: 0, winRate: 0 },
    };
  }

  private sharpe(returns: number[]): number {
    if (returns.length < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    return std === 0 ? 0 : Math.round((mean / std) * Math.sqrt(252) * 100) / 100;
  }
}

interface PricePoint { date: string; ts: number; price: number; }

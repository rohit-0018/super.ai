import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { VersionedTransaction } from '@solana/web3.js';
import { PrismaService } from '../prisma/prisma.service';
import { SnipeSessionService } from './snipe-session.service';
import { RealtimeGateway } from '../ws/realtime.gateway';
import { getJupiterApiBase } from '../common/network-config';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const CHECK_INTERVAL_MS = 10_000; // check every 10s

@Injectable()
export class SnipeSellService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SnipeSellService.name);
  private timer: NodeJS.Timeout | null = null;
  // tradeId → peak price multiple (for trailing stop tracking)
  private peaks = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private snipeSession: SnipeSessionService,
    @Optional() private ws: RealtimeGateway,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.checkPositions().catch((e) =>
      this.logger.warn(`Position check failed: ${e.message}`)
    ), CHECK_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Called from SnipeController for manual sells */
  async manualSell(userId: string, tradeId: string): Promise<{ txHash: string | null }> {
    const trade = await this.prisma.snipeTrade.findFirst({ where: { id: tradeId, userId } });
    if (!trade) throw new Error('Trade not found');
    return this.executeSell(trade as any, 'manual');
  }

  private async checkPositions() {
    const jupBase = getJupiterApiBase();
    if (jupBase === 'MOCK') return; // skip on testnet

    // Find all trades that have tokens (outAmount set, no sell yet)
    const trades = await this.prisma.snipeTrade.findMany({
      where: {
        status: { in: ['broadcast', 'confirmed'] },
        sellStatus: null,
        outAmount: { not: null },
      },
      take: 50, // process max 50 at a time
    });

    for (const trade of trades) {
      try {
        await this.evaluateTrade(trade as any, jupBase);
      } catch (e: any) {
        this.logger.debug(`Eval failed trade=${trade.id}: ${e.message}`);
      }
    }
  }

  private async evaluateTrade(trade: any, jupBase: string) {
    // Load user's effective config (group override → global fallback)
    const config = await this.prisma.snipeConfig.findUnique({ where: { userId: trade.userId } });
    if (!config?.sellEnabled) return;

    // Check group override
    const override = await this.prisma.snipeGroupOverride.findUnique({
      where: { userId_groupId: { userId: trade.userId, groupId: trade.groupId } },
    });
    const sellMode        = override?.sellMode        ?? config.sellMode;
    const takeProfitPct   = override?.takeProfitPct   ?? config.takeProfitPct;
    const stopLossPct     = override?.stopLossPct      ?? config.stopLossPct;
    const trailingStopPct = override?.trailingStopPct  ?? config.trailingStopPct;
    const exitAfterMs     = override?.exitAfterMs      ?? config.exitAfterMs;

    // Time exit
    if (exitAfterMs) {
      const ageMs = Date.now() - new Date(trade.createdAt).getTime();
      if (ageMs >= exitAfterMs) {
        await this.executeSell(trade, 'time_exit');
        return;
      }
    }

    // Fetch current sell value via Jupiter quote
    const currentSol = await this.fetchSellQuote(trade.mint, trade.outAmount, trade.maxSlippageBps ?? 5000, jupBase);
    if (currentSol === null) return;

    const entryLamports = parseInt(trade.amountRaw, 10);
    const priceMul = currentSol / entryLamports; // 1.0 = breakeven, 2.0 = 2x
    const pctChange = (priceMul - 1) * 100;

    // Update peak
    const peakKey = trade.id;
    const peak = Math.max(this.peaks.get(peakKey) ?? priceMul, priceMul);
    this.peaks.set(peakKey, peak);
    await this.prisma.snipeTrade.update({ where: { id: trade.id }, data: { peakPriceMul: peak, sellCheckedAt: new Date() } });

    // Hard stop loss
    if (stopLossPct !== null && stopLossPct !== undefined && pctChange <= stopLossPct) {
      await this.executeSell(trade, 'stop_loss');
      this.peaks.delete(peakKey);
      return;
    }

    // Trailing stop
    if (trailingStopPct !== null && trailingStopPct !== undefined && peak > 1.0) {
      const drawdownFromPeak = ((peak - priceMul) / peak) * 100;
      if (drawdownFromPeak >= trailingStopPct) {
        await this.executeSell(trade, 'trailing_stop');
        this.peaks.delete(peakKey);
        return;
      }
    }

    // Take profit
    if (takeProfitPct !== null && takeProfitPct !== undefined && pctChange >= takeProfitPct) {
      if (sellMode === 'INTELLIGENT') {
        // Mark for intelligent review — don't auto-execute
        await this.prisma.snipeTrade.update({
          where: { id: trade.id },
          data: { sellStatus: 'pending', sellReason: 'take_profit' },
        });
        this.ws?.emitToUser(trade.userId, 'snipe_sell_pending', {
          tradeId: trade.id, mint: trade.mint, pctChange, reason: 'take_profit',
        });
      } else {
        await this.executeSell(trade, 'take_profit');
        this.peaks.delete(peakKey);
      }
    }
  }

  private async fetchSellQuote(mint: string, outAmount: string, slippageBps: number, jupBase: string): Promise<number | null> {
    try {
      const url = new URL(`${jupBase}/quote`);
      url.searchParams.set('inputMint', mint);
      url.searchParams.set('outputMint', SOL_MINT);
      url.searchParams.set('amount', outAmount);
      url.searchParams.set('slippageBps', String(slippageBps));
      const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(4_000) });
      if (!resp.ok) return null;
      const q = await resp.json();
      return parseInt(q.outAmount ?? '0', 10);
    } catch {
      return null;
    }
  }

  private async executeSell(trade: any, reason: string): Promise<{ txHash: string | null }> {
    // Mark as pending sell
    await this.prisma.snipeTrade.update({
      where: { id: trade.id },
      data: { sellStatus: 'pending', sellReason: reason },
    });

    const session = this.snipeSession.getSession(trade.userId);
    const jupBase = getJupiterApiBase();
    if (!session || jupBase === 'MOCK') {
      await this.prisma.snipeTrade.update({ where: { id: trade.id }, data: { sellStatus: 'skip' } });
      return { txHash: null };
    }

    try {
      // Quote: sell all tokens for SOL
      const quoteUrl = new URL(`${jupBase}/quote`);
      quoteUrl.searchParams.set('inputMint', trade.mint);
      quoteUrl.searchParams.set('outputMint', SOL_MINT);
      quoteUrl.searchParams.set('amount', trade.outAmount);
      quoteUrl.searchParams.set('slippageBps', '5000'); // allow 50% slippage on exit (snipe tokens are volatile)
      quoteUrl.searchParams.set('dynamicSlippage', 'true');

      const quoteResp = await fetch(quoteUrl.toString(), { signal: AbortSignal.timeout(5_000) });
      if (!quoteResp.ok) throw new Error(`Quote ${quoteResp.status}`);
      const quote = await quoteResp.json();

      const swapResp = await fetch(`${jupBase}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: session.address,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'veryHigh' },
          },
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!swapResp.ok) throw new Error(`Swap ${swapResp.status}`);
      const { swapTransaction } = await swapResp.json();

      const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
      tx.sign([session.keypair]);
      const sig = await session.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });

      // Realized P&L snapshot — proceeds in SOL come from the quote's outAmount.
      // SOL/USD is approximate (no historical lookup), but it's the right number
      // at sell time, which is what matters for "what did this trade make".
      const proceedsSol = quote?.outAmount
        ? Number(quote.outAmount) / 1_000_000_000
        : null;
      const solPriceUsd = (trade as any).solPriceAtBuyUsd ?? null;
      const proceedsUsd =
        proceedsSol !== null && solPriceUsd !== null ? proceedsSol * solPriceUsd : null;

      const buySolSpent = trade.amountRaw ? Number(trade.amountRaw) / 1_000_000_000 : null;
      const costBasisUsd =
        buySolSpent !== null && solPriceUsd !== null ? buySolSpent * solPriceUsd : null;

      const pnlUsd =
        proceedsUsd !== null && costBasisUsd !== null ? proceedsUsd - costBasisUsd : null;
      const pnlPct =
        pnlUsd !== null && costBasisUsd && costBasisUsd > 0
          ? (pnlUsd / costBasisUsd) * 100
          : null;

      await this.prisma.snipeTrade.update({
        where: { id: trade.id },
        data: {
          sellTxHash: sig,
          sellStatus: 'broadcast',
          sellReason: reason,
          ...(proceedsSol !== null ? { proceedsSolAtSell: proceedsSol } : {}),
          ...(proceedsUsd !== null ? { proceedsUsdAtSell: proceedsUsd } : {}),
          ...(pnlUsd !== null ? { pnlUsdRealized: pnlUsd } : {}),
          ...(pnlPct !== null ? { pnlPctRealized: pnlPct } : {}),
        },
      });

      this.logger.log(`Sell broadcast trade=${trade.id} mint=${trade.mint} reason=${reason} sig=${sig}`);
      this.ws?.emitToUser(trade.userId, 'snipe_sold', {
        tradeId: trade.id, mint: trade.mint, txHash: sig, reason, ts: Date.now(),
      });

      return { txHash: sig };
    } catch (err: any) {
      this.logger.error(`Sell failed trade=${trade.id}: ${err.message}`);
      await this.prisma.snipeTrade.update({
        where: { id: trade.id },
        data: { sellStatus: 'failed' },
      });
      return { txHash: null };
    }
  }
}

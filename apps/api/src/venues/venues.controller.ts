import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MultiChainFeedService } from './multi-chain-feed.service';
import { TradeRouterService } from './trade-router.service';
import { NativePriceService } from './native-price.service';
import { DexScreenerClient } from './providers/dexscreener.client';
import { PerpsMarketService } from './perps/perps-market.service';
import { CHAIN_KEYS, resolveChain } from './chain-registry';

/**
 * The validation pipe is strict (`forbidNonWhitelisted: true`), so every field
 * a client may send needs a decorator here or the whole request is rejected.
 */

const NETWORK_VALUES = ['all', ...CHAIN_KEYS];

class BuyDto {
  @IsString() @IsIn(CHAIN_KEYS) chain!: string;
  @IsString() token!: string;
  @IsNumber() @Min(0.01) amountUsd!: number;
  @IsOptional() @IsInt() @Min(1) @Max(5_000) slippageBps?: number;
  @IsOptional() @IsString() walletId?: string;
}

class SellDto {
  @IsString() @IsIn(CHAIN_KEYS) chain!: string;
  @IsString() token!: string;
  @IsOptional() @IsNumber() @Min(1) @Max(100) percent?: number;
  @IsOptional() @IsString() amountIn?: string;
  @IsOptional() @IsInt() @Min(1) @Max(5_000) slippageBps?: number;
  @IsOptional() @IsString() walletId?: string;
}

class FeedQueryDto {
  @IsOptional() @IsString() @IsIn(NETWORK_VALUES) network?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

@Controller('venues')
export class VenuesController {
  constructor(
    private readonly feed: MultiChainFeedService,
    private readonly router: TradeRouterService,
    private readonly nativePrice: NativePriceService,
    private readonly dex: DexScreenerClient,
    private readonly perps: PerpsMarketService,
  ) {}

  // ── Network chooser ──

  /** Populates the network dropdown, with live per-chain token counts. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('networks')
  networks() {
    return { networks: this.feed.getNetworks() };
  }

  /** The token feed. `network=all` spans every chain. */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('feed')
  getFeed(@Query() q: FeedQueryDto) {
    return this.feed.getFeed((q.network ?? 'all') as any, q.limit ?? 100);
  }

  /** Force an immediate rescan — used by a manual refresh button. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('feed/refresh')
  refresh() {
    void this.feed.scan();
    return { triggered: true, at: new Date().toISOString() };
  }

  /** Cross-chain token search, optionally narrowed to one network. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('search')
  async search(@Query('q') q?: string, @Query('network') network?: string) {
    if (!q || q.trim().length < 2) {
      throw new BadRequestException('q must be at least 2 characters');
    }
    const chain = network && network !== 'all' ? resolveChain(network) : null;
    if (network && network !== 'all' && !chain) {
      throw new BadRequestException(`Unknown network '${network}'`);
    }
    const tokens = await this.dex.search(q.trim(), chain?.key);
    return { query: q, network: network ?? 'all', tokens };
  }

  /** Every pool for one token, deepest first. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('token/:chain/:address')
  async token(@Param('chain') chain: string, @Param('address') address: string) {
    const spec = resolveChain(chain);
    if (!spec) throw new BadRequestException(`Unknown network '${chain}'`);

    const pools = await this.dex.poolsForToken(spec, address);
    const tokens = pools
      .map((p) => this.dex.toFeedToken(spec, p, 'dexscreener_token'))
      .filter((t): t is NonNullable<typeof t> => t != null);

    return {
      chain: spec.key,
      chainName: spec.displayName,
      address,
      poolCount: tokens.length,
      pools: tokens,
      explorerUrl: spec.explorerAddressUrl(address),
    };
  }

  /** Native gas-asset prices — lets the UI size trades without guessing. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('native-prices')
  async nativePrices() {
    return { prices: await this.nativePrice.allPrices(), at: new Date().toISOString() };
  }

  // ── Trading ──

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('buy')
  async buy(@Req() req: any, @Body() dto: BuyDto) {
    return this.router.buy({
      userId: req.user.userId,
      chain: dto.chain,
      token: dto.token,
      amountUsd: dto.amountUsd,
      slippageBps: dto.slippageBps,
      walletId: dto.walletId,
      strategyId: 'venue_manual_buy',
    });
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('sell')
  async sell(@Req() req: any, @Body() dto: SellDto) {
    if (dto.percent == null && !dto.amountIn) {
      throw new BadRequestException('Provide either percent or amountIn');
    }
    return this.router.sell({
      userId: req.user.userId,
      chain: dto.chain,
      token: dto.token,
      percent: dto.percent,
      amountIn: dto.amountIn,
      slippageBps: dto.slippageBps,
      walletId: dto.walletId,
      strategyId: 'venue_manual_sell',
    });
  }

  /** On-chain balance of one token — drives the sell modal's max/percent UI. */
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('position/:chain/:address')
  async position(
    @Req() req: any,
    @Param('chain') chain: string,
    @Param('address') address: string,
  ) {
    const spec = resolveChain(chain);
    if (!spec) throw new BadRequestException(`Unknown network '${chain}'`);

    const wallet = await this.router.walletFor(req.user.userId, spec).catch(() => null);
    if (!wallet) return { chain: spec.key, token: address, position: null };

    const position = await this.router.positionFor(spec, wallet.address, address);
    return { chain: spec.key, token: address, position };
  }

  // ── Perps ──

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('perps/markets')
  perpMarkets(
    @Query('venue') venue?: string,
    @Query('base') base?: string,
    @Query('limit') limit?: string,
  ) {
    const all = base ? this.perps.getMarketsFor(base) : this.perps.getMarkets(venue);
    // Unfiltered this is ~1700 markets. Bounded so a caller cannot accidentally
    // pull the entire cross-venue book on every poll.
    const take = clampLimit(limit, 200, all.length);
    return {
      markets: all.slice(0, take),
      returned: Math.min(take, all.length),
      total: all.length,
      at: this.perps.lastUpdatedAt,
    };
  }

  /**
   * Funding spreads per asset, widest edge first.
   *
   * Compact by default. The full shape embeds every venue's complete market
   * object per spread — 607 spreads x 1377 markets was a 539KB response, with
   * `base`, `symbol` and `at` repeated on every nested entry. Callers that
   * genuinely need the full markets pass `full=1`.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('perps/spreads')
  perpSpreads(@Query('limit') limit?: string, @Query('full') full?: string) {
    const all = this.perps.getSpreads();
    const take = clampLimit(limit, 100, all.length);
    const rows = all.slice(0, take);

    return {
      spreads: full === '1' || full === 'true' ? rows : rows.map(compactSpread),
      returned: rows.length,
      total: all.length,
      at: this.perps.lastUpdatedAt,
    };
  }

  /** Spreads that clear the depth and dispersion filters. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('perps/opportunities')
  perpOpportunities(@Query('minEdge') minEdge?: string) {
    const parsed = minEdge != null ? Number(minEdge) : undefined;
    const threshold = Number.isFinite(parsed) ? parsed : undefined;
    return {
      opportunities: this.perps.getOpportunities(threshold),
      at: this.perps.lastUpdatedAt,
    };
  }
}

/**
 * Strips a spread down to what a list view actually renders. The nested markets
 * keep only venue-varying fields — `base` and `at` live on the parent, and
 * repeating them per venue is what inflated the payload.
 */
function compactSpread(s: any) {
  return {
    base: s.base,
    spreadAprPct: s.spreadAprPct,
    markDispersionPct: s.markDispersionPct,
    cheapestLong: s.cheapestLong,
    richestShort: s.richestShort,
    venues: s.markets.map((m: any) => ({
      venue: m.venue,
      markPrice: m.markPrice,
      fundingAprPct: m.fundingAprPct,
      fundingIntervalHours: m.fundingIntervalHours,
      openInterestUsd: m.openInterestUsd,
      volume24hUsd: m.volume24hUsd,
    })),
    at: s.at,
  };
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = raw != null ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return Math.min(fallback, max);
  return Math.min(n, max);
}

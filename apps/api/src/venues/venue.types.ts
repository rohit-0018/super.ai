/**
 * The venue abstraction: one contract for every place qwai can price or trade
 * an asset — DEX routers (Jupiter, 1inch), perp DEXs (Hyperliquid), and
 * centralized venues (Binance, Bybit, OKX).
 *
 * Design note on perps: modelling perps as an afterthought is the usual trap —
 * you end up with a `Quote` that means "swap output" for spot and something
 * subtly different for a leveraged fill. So `Instrument` carries an explicit
 * `kind`, and the perp-only economics (funding, OI, leverage, liquidation)
 * live in their own types rather than being smuggled into the spot shapes as
 * optional fields.
 */

import type { ChainKey } from './chain-registry';

export type VenueKind = 'DEX' | 'PERP_DEX' | 'CEX';
export type InstrumentKind = 'SPOT' | 'PERP';
export type Side = 'BUY' | 'SELL';
/** Perp direction. Kept distinct from `Side` — a SELL can close a long or open a short. */
export type PositionSide = 'LONG' | 'SHORT';

/**
 * A canonical reference to something tradable. Three disjoint shapes because
 * the identifying information genuinely differs: an on-chain token is
 * (chain, address), a CEX listing is (venue, symbol), a perp is (venue, base).
 */
export type AssetRef =
  | { kind: 'onchain'; chain: ChainKey; address: string; symbol?: string }
  | { kind: 'cex'; venue: string; symbol: string }
  | { kind: 'perp'; venue: string; base: string };

export interface Instrument {
  kind: InstrumentKind;
  /** Stable id: `solana:So111...`, `hyperliquid:BTC-PERP`, `binance:BTCUSDT`. */
  id: string;
  symbol: string;
  name?: string;
  venue: string;
  chain?: ChainKey;
  address?: string;
  /** Perp only. */
  maxLeverage?: number;
  /** Smallest tradable size increment, as a decimal string. */
  sizeIncrement?: string;
}

// ── Market data ──

export interface PriceSnapshot {
  instrumentId: string;
  symbol: string;
  priceUsd: number;
  change1h?: number;
  change24h?: number;
  volume24hUsd?: number;
  liquidityUsd?: number;
  marketCapUsd?: number;
  at: string; // ISO
}

/** Perp-specific market state. Funding is the whole game for basis strategies. */
export interface PerpMarket {
  venue: string;
  base: string;              // 'BTC'
  symbol: string;            // venue-native: 'BTC' | 'BTCUSDT'
  markPrice: number;
  indexPrice?: number;
  oraclePrice?: number;
  /** Current funding rate as a per-interval decimal (0.0001 = 1bp). */
  fundingRate: number;
  /** Hours between funding payments — Hyperliquid is 1h, Binance/Bybit 8h. */
  fundingIntervalHours: number;
  /** Normalized to an APR so venues with different intervals compare directly. */
  fundingAprPct: number;
  nextFundingAt?: string;
  openInterestUsd?: number;
  volume24hUsd?: number;
  maxLeverage?: number;
  at: string;
}

/**
 * Same base asset across venues, aligned for basis/funding-arb detection.
 * This is the primary input to the perps automation layer.
 */
export interface FundingSpread {
  base: string;
  markets: PerpMarket[];
  /** Venue with the lowest (most negative) funding — cheapest to be long. */
  cheapestLong: { venue: string; fundingAprPct: number };
  /** Venue with the highest funding — best paid to be short. */
  richestShort: { venue: string; fundingAprPct: number };
  /** richestShort - cheapestLong, in APR points. The arb edge before costs. */
  spreadAprPct: number;
  /** Max |mark - mark| across venues as a % of the median mark. */
  markDispersionPct: number;
  at: string;
}

// ── Quoting ──

export interface QuoteRequest {
  instrument: Instrument;
  side: Side;
  /** Base-units string for on-chain (lamports/wei), decimal string for CEX/perp. */
  amountIn: string;
  slippageBps: number;
  /** Perp only. */
  leverage?: number;
  taker?: string; // wallet/account placing the order
}

export interface VenueQuote {
  venue: string;
  instrumentId: string;
  side: Side;
  amountIn: string;
  /** Expected output in base units. */
  amountOut: string;
  priceUsd?: number;
  priceImpactPct?: number;
  /** Venue fee in bps — DEX LP fee or CEX taker fee. */
  feeBps?: number;
  /** Estimated gas in USD. Zero for CEX. */
  gasUsd?: number;
  /** Everything-in cost so the router can compare venues honestly. */
  effectiveCostBps?: number;
  route?: string[];
  /** Opaque venue payload replayed into execute() so we never re-quote. */
  raw?: unknown;
  expiresAt?: string;
}

export interface ExecuteRequest extends QuoteRequest {
  userId: string;
  /** Pass the quote back to execute against it. */
  quote?: VenueQuote;
  walletId?: string;
  reduceOnly?: boolean;
  positionSide?: PositionSide;
}

export interface VenueFill {
  venue: string;
  instrumentId: string;
  side: Side;
  /** On-chain tx hash, or venue order id for CEX/perp. */
  ref: string;
  amountIn: string;
  amountOut: string;
  priceUsd?: number;
  feeUsd?: number;
  status: 'FILLED' | 'PENDING' | 'FAILED';
  explorerUrl?: string;
  at: string;
}

export interface VenueBalance {
  asset: string;
  free: string;
  locked?: string;
  usdValue?: number;
}

export interface PerpPosition {
  venue: string;
  base: string;
  side: PositionSide;
  size: string;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  unrealizedPnlUsd: number;
  liquidationPrice?: number;
  marginUsd?: number;
}

// ── The adapter contract ──

export interface VenueCapabilities {
  spot: boolean;
  perps: boolean;
  quote: boolean;
  execute: boolean;
  balances: boolean;
  /** True when market data needs no API key — lets us use it for public feeds. */
  publicMarketData: boolean;
}

export interface VenueAdapter {
  readonly key: string;
  readonly kind: VenueKind;
  readonly capabilities: VenueCapabilities;
  /** Chains this venue can settle on. Empty for CEX. */
  readonly chains: ChainKey[];

  /** Cheap liveness probe used by the router to skip dead venues. */
  isAvailable(): Promise<boolean>;

  quote?(req: QuoteRequest): Promise<VenueQuote | null>;
  execute?(req: ExecuteRequest): Promise<VenueFill>;
  balances?(userId: string): Promise<VenueBalance[]>;

  /** Perp venues only. */
  perpMarkets?(): Promise<PerpMarket[]>;
  perpPositions?(userId: string): Promise<PerpPosition[]>;
}

// ── Multi-chain token feed (what the network chooser renders) ──

export type NetworkFilter = ChainKey | 'all';

export interface FeedToken {
  chain: ChainKey;
  chainName: string;
  address: string;
  symbol: string;
  name: string;
  priceUsd: number;
  priceChange5m?: number;
  priceChange1h?: number;
  priceChange24h?: number;
  volume24hUsd: number;
  liquidityUsd: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  pairAddress?: string;
  pairAgeHours?: number;
  dex?: string;
  buys24h?: number;
  sells24h?: number;
  /** Which discovery surface produced this row. */
  source: string;
  dexUrl?: string;
  imageUrl?: string;
  /** True when the chain has a wired router and the token can be bought now. */
  tradable: boolean;
}

export interface FeedResult {
  tokens: FeedToken[];
  /** Per-chain counts so the chooser can render badges without a second call. */
  countsByChain: Record<string, number>;
  network: NetworkFilter;
  fetchedAt: string;
  stale: boolean;
}

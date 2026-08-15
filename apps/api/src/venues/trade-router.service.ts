/**
 * Chain-agnostic buy/sell.
 *
 * The existing execution path works but every caller has to know chain-specific
 * trivia: which mint represents native SOL, that 1inch wants a magic
 * 0xEeee… address for native ETH, how many decimals the token has, and how to
 * smuggle the EVM chain id through `riskFlags`. hot-tokens.controller.ts
 * signalBuy() is the clearest example — it is hardcoded to Solana and carries a
 * `?? 140` SOL price fallback inline.
 *
 * This service absorbs all of that so a caller only needs:
 *   buy({ chain, token, amountUsd })   sell({ chain, token, percent })
 *
 * It delegates the actual signing/submission to ExecutionService, which keeps
 * guardrails, paper-trade mode, and trade recording in exactly one place.
 */

import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Connection, PublicKey } from '@solana/web3.js';
import { ethers } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionService, type SwapResult } from '../execution/execution.service';
import { getChain, resolveChain, rpcUrlFor, type ChainKey, type ChainSpec } from './chain-registry';
import { NativePriceService } from './native-price.service';

/** 1inch's sentinel address for "the chain's native asset, not an ERC20". */
const EVM_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export interface BuyRequest {
  userId: string;
  chain: ChainKey | string;
  /** Token mint (Solana) or contract address (EVM). */
  token: string;
  amountUsd: number;
  slippageBps?: number;
  walletId?: string;
  strategyId?: string;
}

export interface SellRequest {
  userId: string;
  chain: ChainKey | string;
  token: string;
  /** Fraction of holdings to sell, 1-100. Ignored when `amountIn` is given. */
  percent?: number;
  /** Exact amount in the token's base units. Takes precedence over `percent`. */
  amountIn?: string;
  slippageBps?: number;
  walletId?: string;
  strategyId?: string;
}

export interface TokenPosition {
  chain: ChainKey;
  token: string;
  symbol?: string;
  decimals: number;
  /** Raw base units. */
  rawBalance: string;
  /** Human-readable. */
  balance: number;
}

const DEFAULT_SLIPPAGE_BPS = 300;

@Injectable()
export class TradeRouterService {
  private readonly logger = new Logger(TradeRouterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nativePrice: NativePriceService,
    @Optional() private readonly exec?: ExecutionService,
  ) {}

  /** USD → native → swap. Works identically on every registered chain. */
  async buy(req: BuyRequest): Promise<SwapResult & { chain: ChainKey; explorerUrl?: string }> {
    const spec = this.requireChain(req.chain);
    if (!this.exec) throw new BadRequestException('Execution service unavailable');
    if (!(req.amountUsd > 0)) throw new BadRequestException('amountUsd must be positive');

    const wallet = await this.walletFor(req.userId, spec, req.walletId);

    // Size the order in native base units from a live native price.
    const nativeUsd = await this.nativePrice.priceFor(spec);
    const nativeAmount = req.amountUsd / nativeUsd;
    const amountIn = toBaseUnits(nativeAmount, spec.nativeDecimals);

    if (amountIn === '0') {
      throw new BadRequestException(
        `$${req.amountUsd} is below the minimum tradable size on ${spec.displayName}`,
      );
    }

    const result = await this.exec.swap({
      userId: req.userId,
      walletId: wallet.id,
      chain: spec.family,
      evmChainId: spec.evmChainId,
      tokenIn: spec.family === 'SOLANA' ? SOL_MINT : EVM_NATIVE,
      tokenOut: req.token,
      amountIn,
      notionalUsd: req.amountUsd,
      slippageBps: req.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      strategyId: req.strategyId,
    });

    return {
      ...result,
      chain: spec.key,
      explorerUrl: result.txHash ? spec.explorerTxUrl(result.txHash) : undefined,
    };
  }

  /** Sell a percentage of holdings, or an exact base-unit amount. */
  async sell(req: SellRequest): Promise<SwapResult & { chain: ChainKey; explorerUrl?: string }> {
    const spec = this.requireChain(req.chain);
    if (!this.exec) throw new BadRequestException('Execution service unavailable');

    const wallet = await this.walletFor(req.userId, spec, req.walletId);

    let amountIn = req.amountIn;
    let decimals: number | undefined;

    if (!amountIn) {
      const pct = req.percent ?? 100;
      if (pct <= 0 || pct > 100) throw new BadRequestException('percent must be between 1 and 100');

      const pos = await this.positionFor(spec, wallet.address, req.token);
      if (!pos || pos.rawBalance === '0') {
        throw new NotFoundException(`No ${req.token} balance on ${spec.displayName}`);
      }
      decimals = pos.decimals;

      // Percentage applied in integer space — float math on raw balances loses
      // precision badly for 18-decimal tokens and can round a 100% sell down
      // to a dust remainder that then blocks the position from ever closing.
      amountIn = ((BigInt(pos.rawBalance) * BigInt(Math.round(pct * 100))) / 10_000n).toString();
      if (amountIn === '0') {
        throw new BadRequestException(`${pct}% of the position rounds to zero`);
      }
    }

    // Notional is best-effort — used for guardrail sizing, not for the swap math.
    const notionalUsd = await this.estimateNotional(spec, req.token, amountIn, decimals);

    const result = await this.exec.swap({
      userId: req.userId,
      walletId: wallet.id,
      chain: spec.family,
      evmChainId: spec.evmChainId,
      tokenIn: req.token,
      tokenOut: spec.family === 'SOLANA' ? SOL_MINT : EVM_NATIVE,
      amountIn,
      notionalUsd,
      slippageBps: req.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      strategyId: req.strategyId,
    });

    return {
      ...result,
      chain: spec.key,
      explorerUrl: result.txHash ? spec.explorerTxUrl(result.txHash) : undefined,
    };
  }

  /** On-chain balance of one token for a wallet. Null when the wallet holds none. */
  async positionFor(spec: ChainSpec, owner: string, token: string): Promise<TokenPosition | null> {
    return spec.family === 'SOLANA'
      ? this.solanaPosition(spec, owner, token)
      : this.evmPosition(spec, owner, token);
  }

  private async solanaPosition(spec: ChainSpec, owner: string, mint: string): Promise<TokenPosition | null> {
    try {
      const conn = new Connection(rpcUrlFor(spec), 'confirmed');
      const accounts = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), {
        mint: new PublicKey(mint),
      });
      if (!accounts.value.length) return null;

      // A mint can have several token accounts for one owner; sum them.
      let raw = 0n;
      let decimals = 0;
      for (const { account } of accounts.value) {
        const info = (account.data as any)?.parsed?.info?.tokenAmount;
        if (!info) continue;
        raw += BigInt(info.amount ?? '0');
        decimals = info.decimals ?? decimals;
      }
      if (raw === 0n) return null;

      return {
        chain: spec.key,
        token: mint,
        decimals,
        rawBalance: raw.toString(),
        balance: Number(raw) / 10 ** decimals,
      };
    } catch (e: any) {
      this.logger.warn(`Solana balance lookup failed for ${mint}: ${e?.message}`);
      return null;
    }
  }

  private async evmPosition(spec: ChainSpec, owner: string, token: string): Promise<TokenPosition | null> {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrlFor(spec));
      const erc20 = new ethers.Contract(token, ERC20_ABI, provider);
      const [raw, decimals, symbol] = await Promise.all([
        erc20.balanceOf(owner) as Promise<bigint>,
        erc20.decimals() as Promise<bigint>,
        (erc20.symbol() as Promise<string>).catch(() => undefined),
      ]);
      if (raw === 0n) return null;

      const dec = Number(decimals);
      return {
        chain: spec.key,
        token,
        symbol,
        decimals: dec,
        rawBalance: raw.toString(),
        balance: Number(ethers.formatUnits(raw, dec)),
      };
    } catch (e: any) {
      this.logger.warn(`EVM balance lookup failed for ${token} on ${spec.key}: ${e?.message}`);
      return null;
    }
  }

  /**
   * Best-effort USD value of a sell. Falls back to 0 rather than throwing —
   * a missing price should not block an exit, and guardrails treat 0 as
   * "unknown size" rather than "free".
   */
  private async estimateNotional(
    spec: ChainSpec,
    token: string,
    amountIn: string,
    knownDecimals?: number,
  ): Promise<number> {
    try {
      const res = await fetch(
        `https://api.dexscreener.com/tokens/v1/${spec.ids.dexscreener}/${token}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3_000) },
      );
      if (!res.ok) return 0;
      const pairs = (await res.json()) as any[];
      if (!Array.isArray(pairs) || !pairs.length) return 0;

      const best = pairs.sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0))[0];
      const price = Number(best?.priceUsd);
      if (!Number.isFinite(price)) return 0;

      const decimals = knownDecimals ?? (spec.family === 'SOLANA' ? 6 : 18);
      return (Number(amountIn) / 10 ** decimals) * price;
    } catch {
      return 0;
    }
  }

  private requireChain(chain: ChainKey | string): ChainSpec {
    const spec = resolveChain(chain);
    if (!spec) {
      throw new BadRequestException(
        `Unsupported network '${chain}'. Call GET /api/venues/networks for the supported list.`,
      );
    }
    return spec;
  }

  /**
   * Picks the wallet to trade from. Wallets are stored against the coarse
   * Prisma family (SOLANA | EVM), so one EVM wallet serves every EVM chain —
   * the address is identical across them.
   */
  async walletFor(userId: string, spec: ChainSpec, walletId?: string) {
    const wallet = walletId
      ? await this.prisma.wallet.findFirst({ where: { id: walletId, userId } })
      : await this.prisma.wallet.findFirst({
          where: { userId, chain: spec.family },
          orderBy: { createdAt: 'asc' },
        });

    if (!wallet) {
      throw new NotFoundException(
        `No ${spec.family} wallet found — create one before trading on ${spec.displayName}`,
      );
    }
    return wallet;
  }
}

/**
 * Decimal amount → integer base units, without floating-point drift.
 *
 * `0.1 * 1e18` is not an integer in IEEE-754, so the naive multiply is wrong.
 * `toFixed(20)` is equally wrong in the other direction: it exposes the float's
 * true binary expansion, turning 0.1 into "0.10000000000000000555" and yielding
 * 100000000000000005 base units.
 *
 * We instead start from `String(amount)`, which is JS's *shortest round-tripping*
 * representation ("0.1"), and do exact string manipulation from there.
 */
export function toBaseUnits(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '0';

  const [whole, frac = ''] = toPlainDecimalString(amount).split('.');
  // Truncate rather than round — never submit more than the user asked for.
  const paddedFrac = frac.slice(0, decimals).padEnd(decimals, '0');
  const combined = `${whole}${paddedFrac}`.replace(/^0+(?=\d)/, '');
  return combined === '' ? '0' : combined;
}

/**
 * Expands JS exponential notation into a plain decimal string.
 * `String()` switches to exponential below 1e-6 and above 1e21 — both ranges a
 * real trade can hit (dust sells, 18-decimal whale positions) — and the naive
 * `split('.')` above would silently mangle "1e-7" into a 1.
 */
function toPlainDecimalString(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;

  const [mantissa, expPart] = s.split(/e/i);
  const exp = parseInt(expPart, 10);
  const negative = mantissa.startsWith('-');
  const m = negative ? mantissa.slice(1) : mantissa;
  const [mWhole, mFrac = ''] = m.split('.');
  const digits = mWhole + mFrac;
  const pointPos = mWhole.length + exp;

  let out: string;
  if (pointPos <= 0) {
    out = `0.${'0'.repeat(-pointPos)}${digits}`;
  } else if (pointPos >= digits.length) {
    out = digits + '0'.repeat(pointPos - digits.length);
  } else {
    out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  }
  return negative ? `-${out}` : out;
}

/**
 * Bulk wallet operations — create / fund / sweep many wallets in one action.
 *
 * Multi-wallet is a normal qwai flow (sniping across 20+ wallets), and doing it
 * by hand is the bottleneck this service removes.
 *
 * Two hard rules, because these move real money irreversibly:
 *
 *  1. **Every mutating op is preview-first.** `plan*` returns exactly what would
 *     happen — per-wallet amounts, fees, totals, and any blockers — without
 *     touching a key. `execute*` refuses to run unless the caller passes
 *     `confirm: true`. There is no single call that silently moves funds.
 *  2. **Sweeps always reserve gas.** Draining a wallet to zero on an EVM chain
 *     strands it: you cannot then send anything out, including the token you
 *     forgot. We compute the real gas cost and leave it behind, plus a buffer.
 *
 * Chain handling goes through the venue registry, so a transfer on Base uses
 * Base's RPC. The pre-existing `withdrawEvm` in wallets.service.ts hardcodes
 * `getEvmRpcUrl()` (Ethereum) for every EVM chain — that bug is not repeated here.
 */

import { BadRequestException, ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { Chain } from '@prisma/client';
import { ethers } from 'ethers';
import { Keypair } from '@solana/web3.js';
import { PrismaService } from '../prisma/prisma.service';
import { KmsService } from './kms.service';
import { WalletsService } from './wallets.service';
import { LiveTradeGuardService } from '../common/live-trade-guard.service';
import { EvmBalancesService } from '../venues/evm-balances.service';
import { NativePriceService } from '../venues/native-price.service';
import { getChain, resolveChain, rpcUrlFor, type ChainSpec } from '../venues/chain-registry';

/** Hard ceiling on wallets created in one call — guards against a fat-fingered 10000. */
const MAX_BULK_CREATE = 50;
/** Hard ceiling on transfers per bulk op. */
const MAX_BULK_TRANSFERS = 100;
/** Transfers run in small waves so we don't trip public-RPC rate limits. */
const TRANSFER_CONCURRENCY = 4;
/** Extra gas headroom on top of the estimate, as a multiplier. */
const GAS_BUFFER = 1.5;
/** Solana rent-exempt minimum + fee headroom, in SOL. */
const SOL_RESERVE = 0.002;

export interface BulkCreateInput {
  userId: string;
  chain: Chain;
  count: number;
  labelPrefix?: string;
}

export interface DistributeInput {
  userId: string;
  /** Wallet funds come from. */
  fromWalletId: string;
  /** Explicit targets. When omitted, every other wallet on the chain is used. */
  toWalletIds?: string[];
  /** Native amount each target receives. */
  amountPerWallet: number;
  /** Which chain to move value on. Defaults to the funding wallet's chain. */
  chainKey?: string;
  confirm?: boolean;
}

export interface CollectInput {
  userId: string;
  /** Wallets to drain. When omitted, every wallet on the chain except the target. */
  fromWalletIds?: string[];
  /** Wallet that receives everything. */
  toWalletId: string;
  chainKey?: string;
  /** Native units deliberately left behind. Defaults to the computed gas cost. */
  leaveBehind?: number;
  confirm?: boolean;
}

export interface TransferPlanRow {
  walletId: string;
  address: string;
  label: string | null;
  /** Native amount this row moves. */
  amount: number;
  /** Balance before the move. */
  balanceBefore: number;
  estimatedFee: number;
  usdValue: number;
  /** Populated when this row cannot run — it is excluded from execution. */
  blocked?: string;
}

export interface TransferPlan {
  op: 'distribute' | 'collect';
  chain: string;
  chainName: string;
  nativeSymbol: string;
  from?: { walletId: string; address: string; balance: number };
  to?: { walletId: string; address: string };
  rows: TransferPlanRow[];
  totalAmount: number;
  totalFees: number;
  totalUsd: number;
  actionable: number;
  blocked: number;
  /** Reason the whole plan cannot proceed, if any. */
  fatal?: string;
}

export interface TransferResultRow {
  walletId: string;
  address: string;
  amount: number;
  status: 'sent' | 'failed' | 'skipped';
  txHash?: string;
  explorerUrl?: string;
  error?: string;
}

@Injectable()
export class BulkWalletService {
  private readonly logger = new Logger(BulkWalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kms: KmsService,
    private readonly wallets: WalletsService,
    private readonly liveGuard: LiveTradeGuardService,
    @Optional() private readonly evmBalances?: EvmBalancesService,
    @Optional() private readonly nativePrice?: NativePriceService,
  ) {}

  // ── Create ──

  /**
   * Creates `count` wallets in one go. Reuses WalletsService.create so key
   * generation, KMS envelope encryption, cap enforcement and audit logging stay
   * in exactly one place.
   *
   * Returns each wallet's private key ONCE — same contract as single create.
   * The caller is expected to prompt for backup immediately.
   */
  async bulkCreate(input: BulkCreateInput) {
    const { userId, chain, count } = input;
    if (!Number.isInteger(count) || count < 1) {
      throw new BadRequestException('count must be a positive integer');
    }
    if (count > MAX_BULK_CREATE) {
      throw new BadRequestException(`count exceeds the ${MAX_BULK_CREATE} per-call limit`);
    }

    const created: any[] = [];
    const failed: Array<{ index: number; error: string }> = [];

    // Sequential: WalletsService.create reads a count to build the default label
    // and to enforce the per-user cap. Running these in parallel races both.
    for (let i = 0; i < count; i++) {
      try {
        const label = input.labelPrefix ? `${input.labelPrefix} ${i + 1}` : undefined;
        created.push(await this.wallets.create(userId, chain, label));
      } catch (e: any) {
        failed.push({ index: i, error: e?.message ?? 'create failed' });
        // A cap breach fails every subsequent attempt too — stop rather than
        // emitting the same error N more times.
        if (String(e?.message ?? '').includes('cap')) break;
      }
    }

    await this.audit(userId, 'wallet.bulk_create', 'bulk', {
      chain,
      requested: count,
      created: created.length,
      failed: failed.length,
    });

    return { requested: count, created, failed };
  }

  // ── Distribute (fund many from one) ──

  async planDistribute(input: DistributeInput): Promise<TransferPlan> {
    const { spec, funder, targets } = await this.resolveDistribute(input);

    const price = (await this.nativePrice?.priceFor(spec).catch(() => 0)) ?? 0;
    const funderBalance = await this.nativeBalanceOf(spec, funder.address);
    const feePer = await this.estimateFee(spec);

    const rows: TransferPlanRow[] = [];
    for (const t of targets) {
      rows.push({
        walletId: t.id,
        address: t.address,
        label: t.label,
        amount: input.amountPerWallet,
        balanceBefore: 0, // filled below only when cheap to know
        estimatedFee: feePer,
        usdValue: input.amountPerWallet * price,
      });
    }

    const totalAmount = input.amountPerWallet * rows.length;
    const totalFees = feePer * rows.length;

    const plan: TransferPlan = {
      op: 'distribute',
      chain: spec.key,
      chainName: spec.displayName,
      nativeSymbol: spec.nativeSymbol,
      from: { walletId: funder.id, address: funder.address, balance: funderBalance },
      rows,
      totalAmount,
      totalFees,
      totalUsd: totalAmount * price,
      actionable: rows.length,
      blocked: 0,
    };

    // Surfacing this as a fatal on the plan (rather than throwing) lets the UI
    // render the full breakdown alongside the reason it cannot run.
    if (funderBalance < totalAmount + totalFees) {
      plan.fatal =
        `Funding wallet holds ${funderBalance.toFixed(6)} ${spec.nativeSymbol} but the plan needs ` +
        `${(totalAmount + totalFees).toFixed(6)} (${totalAmount.toFixed(6)} + ~${totalFees.toFixed(6)} fees)`;
    }
    if (!rows.length) plan.fatal = 'No target wallets found on this chain';

    return plan;
  }

  async executeDistribute(input: DistributeInput) {
    if (!input.confirm) {
      throw new BadRequestException('Refusing to move funds without confirm: true — call the plan endpoint first');
    }
    await this.liveGuard.checkLiveWithdraw({ userId: input.userId });

    const plan = await this.planDistribute(input);
    if (plan.fatal) throw new BadRequestException(plan.fatal);

    const spec = getChain(plan.chain as any);
    const results = await this.runTransfers(
      input.userId,
      spec,
      plan.rows.map((r) => ({
        fromWalletId: input.fromWalletId,
        toAddress: r.address,
        toWalletId: r.walletId,
        amount: r.amount,
      })),
    );

    await this.audit(input.userId, 'wallet.bulk_distribute', plan.from?.address ?? 'bulk', {
      chain: spec.key,
      count: results.length,
      sent: results.filter((r) => r.status === 'sent').length,
      amountPerWallet: input.amountPerWallet,
    });

    return { plan, results, summary: summarize(results) };
  }

  // ── Collect (sweep many into one) ──

  async planCollect(input: CollectInput): Promise<TransferPlan> {
    const { spec, target, sources } = await this.resolveCollect(input);

    const price = (await this.nativePrice?.priceFor(spec).catch(() => 0)) ?? 0;
    const feePer = await this.estimateFee(spec);
    // Reserve enough to cover the outbound transaction itself, or the caller's
    // explicit floor. Sweeping to exactly zero bricks the wallet.
    const reserve = input.leaveBehind ?? (spec.family === 'SOLANA' ? SOL_RESERVE : feePer * GAS_BUFFER);

    const balances = await Promise.all(
      sources.map((s) => this.nativeBalanceOf(spec, s.address).catch(() => 0)),
    );

    const rows: TransferPlanRow[] = sources.map((s, i) => {
      const balance = balances[i];
      const sendable = balance - reserve;
      const row: TransferPlanRow = {
        walletId: s.id,
        address: s.address,
        label: s.label,
        amount: Math.max(0, sendable),
        balanceBefore: balance,
        estimatedFee: feePer,
        usdValue: Math.max(0, sendable) * price,
      };
      if (sendable <= 0) {
        row.blocked =
          balance <= 0
            ? 'Empty wallet'
            : `Balance ${balance.toFixed(6)} below the ${reserve.toFixed(6)} ${spec.nativeSymbol} gas reserve`;
      }
      return row;
    });

    const actionable = rows.filter((r) => !r.blocked);

    return {
      op: 'collect',
      chain: spec.key,
      chainName: spec.displayName,
      nativeSymbol: spec.nativeSymbol,
      to: { walletId: target.id, address: target.address },
      rows,
      totalAmount: actionable.reduce((s, r) => s + r.amount, 0),
      totalFees: actionable.length * feePer,
      totalUsd: actionable.reduce((s, r) => s + r.usdValue, 0),
      actionable: actionable.length,
      blocked: rows.length - actionable.length,
      ...(actionable.length === 0 ? { fatal: 'Nothing to collect — every wallet is empty or below the gas reserve' } : {}),
    };
  }

  async executeCollect(input: CollectInput) {
    if (!input.confirm) {
      throw new BadRequestException('Refusing to move funds without confirm: true — call the plan endpoint first');
    }
    await this.liveGuard.checkLiveWithdraw({ userId: input.userId });

    const plan = await this.planCollect(input);
    if (plan.fatal) throw new BadRequestException(plan.fatal);

    const spec = getChain(plan.chain as any);
    const results = await this.runTransfers(
      input.userId,
      spec,
      plan.rows
        .filter((r) => !r.blocked)
        .map((r) => ({
          fromWalletId: r.walletId,
          toAddress: plan.to!.address,
          toWalletId: plan.to!.walletId,
          amount: r.amount,
        })),
    );

    await this.audit(input.userId, 'wallet.bulk_collect', plan.to?.address ?? 'bulk', {
      chain: spec.key,
      count: results.length,
      sent: results.filter((r) => r.status === 'sent').length,
    });

    return { plan, results, summary: summarize(results) };
  }

  // ── Shared execution ──

  /**
   * Runs transfers in bounded waves.
   *
   * Concurrency is capped because these all hit one public RPC, and on EVM
   * several transfers may originate from the same address — firing them in
   * parallel produces nonce collisions. Within a wave each transfer is from a
   * distinct wallet for the collect case; for distribute they share a sender, so
   * that path is forced sequential below.
   */
  private async runTransfers(
    userId: string,
    spec: ChainSpec,
    jobs: Array<{ fromWalletId: string; toAddress: string; toWalletId: string; amount: number }>,
  ): Promise<TransferResultRow[]> {
    if (jobs.length > MAX_BULK_TRANSFERS) {
      throw new BadRequestException(`Refusing more than ${MAX_BULK_TRANSFERS} transfers in one call`);
    }

    // Same sender across jobs => must be sequential to keep nonces ordered.
    const sharedSender = new Set(jobs.map((j) => j.fromWalletId)).size === 1 && jobs.length > 1;
    const concurrency = sharedSender ? 1 : TRANSFER_CONCURRENCY;

    const out: TransferResultRow[] = [];
    for (let i = 0; i < jobs.length; i += concurrency) {
      const wave = jobs.slice(i, i + concurrency);
      const settled = await Promise.all(
        wave.map(async (job): Promise<TransferResultRow> => {
          const base = {
            walletId: job.fromWalletId,
            address: job.toAddress,
            amount: job.amount,
          };
          try {
            const txHash = await this.sendNative(userId, spec, job.fromWalletId, job.toAddress, job.amount);
            return { ...base, status: 'sent', txHash, explorerUrl: spec.explorerTxUrl(txHash) };
          } catch (e: any) {
            this.logger.warn(`transfer failed ${job.fromWalletId} → ${job.toAddress}: ${e?.message}`);
            return { ...base, status: 'failed', error: e?.message ?? 'transfer failed' };
          }
        }),
      );
      out.push(...settled);
    }
    return out;
  }

  /** Chain-aware native transfer. Uses the registry RPC, never a global default. */
  private async sendNative(
    userId: string,
    spec: ChainSpec,
    fromWalletId: string,
    toAddress: string,
    amount: number,
  ): Promise<string> {
    return this.wallets.withSigningKey(userId, fromWalletId, async (key) => {
      if (spec.family === 'SOLANA') {
        const { Connection, Transaction, SystemProgram, PublicKey, sendAndConfirmTransaction } =
          await import('@solana/web3.js');
        const kp = Keypair.fromSecretKey(key);
        const conn = new Connection(rpcUrlFor(spec), 'confirmed');
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: new PublicKey(toAddress),
            lamports: Math.round(amount * 1e9),
          }),
        );
        return sendAndConfirmTransaction(conn, tx, [kp]);
      }

      const provider = new ethers.JsonRpcProvider(rpcUrlFor(spec), spec.evmChainId, {
        staticNetwork: true,
      });
      const signer = new ethers.Wallet('0x' + key.toString('hex'), provider);
      const tx = await signer.sendTransaction({
        to: toAddress,
        value: ethers.parseUnits(amount.toFixed(spec.nativeDecimals), spec.nativeDecimals),
      });
      await tx.wait(1);
      return tx.hash;
    });
  }

  // ── Helpers ──

  private async resolveDistribute(input: DistributeInput) {
    if (!(input.amountPerWallet > 0)) {
      throw new BadRequestException('amountPerWallet must be positive');
    }

    const funder = await this.prisma.wallet.findFirst({
      where: { id: input.fromWalletId, userId: input.userId },
    });
    if (!funder) throw new ForbiddenException('Funding wallet not found');

    const spec = this.resolveSpec(input.chainKey, funder.chain);

    const targets = input.toWalletIds?.length
      ? await this.prisma.wallet.findMany({
          where: { id: { in: input.toWalletIds }, userId: input.userId, chain: spec.family },
        })
      : await this.prisma.wallet.findMany({
          where: { userId: input.userId, chain: spec.family, id: { not: funder.id } },
          orderBy: { createdAt: 'asc' },
        });

    // Guard against the wallet paying itself — a no-op that still burns gas.
    return { spec, funder, targets: targets.filter((t) => t.id !== funder.id) };
  }

  private async resolveCollect(input: CollectInput) {
    const target = await this.prisma.wallet.findFirst({
      where: { id: input.toWalletId, userId: input.userId },
    });
    if (!target) throw new ForbiddenException('Destination wallet not found');

    const spec = this.resolveSpec(input.chainKey, target.chain);

    const sources = input.fromWalletIds?.length
      ? await this.prisma.wallet.findMany({
          where: { id: { in: input.fromWalletIds }, userId: input.userId, chain: spec.family },
        })
      : await this.prisma.wallet.findMany({
          where: { userId: input.userId, chain: spec.family, id: { not: target.id } },
          orderBy: { createdAt: 'asc' },
        });

    return { spec, target, sources: sources.filter((s) => s.id !== target.id) };
  }

  /**
   * A wallet row stores only the coarse family (SOLANA | EVM). For EVM the
   * caller must say which chain they mean; defaulting silently would move funds
   * on the wrong network, so Ethereum is only assumed when nothing is supplied.
   */
  private resolveSpec(chainKey: string | undefined, family: Chain): ChainSpec {
    if (chainKey) {
      const spec = resolveChain(chainKey);
      if (!spec) throw new BadRequestException(`Unknown network '${chainKey}'`);
      if (spec.family !== family) {
        throw new BadRequestException(
          `Network '${spec.key}' is ${spec.family} but the wallet is ${family}`,
        );
      }
      return spec;
    }
    return family === 'SOLANA' ? getChain('solana') : getChain('ethereum');
  }

  private async nativeBalanceOf(spec: ChainSpec, address: string): Promise<number> {
    if (spec.family === 'EVM') {
      if (this.evmBalances) return this.evmBalances.nativeBalance(spec, address);
      const provider = new ethers.JsonRpcProvider(rpcUrlFor(spec), spec.evmChainId, {
        staticNetwork: true,
      });
      return Number(ethers.formatUnits(await provider.getBalance(address), spec.nativeDecimals));
    }
    const { Connection, PublicKey, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
    const conn = new Connection(rpcUrlFor(spec), 'confirmed');
    return (await conn.getBalance(new PublicKey(address))) / LAMPORTS_PER_SOL;
  }

  /** Native-denominated cost of one simple transfer on this chain. */
  private async estimateFee(spec: ChainSpec): Promise<number> {
    if (spec.family === 'SOLANA') return 0.000005; // 5000 lamports, fixed
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrlFor(spec), spec.evmChainId, {
        staticNetwork: true,
      });
      const fee = await provider.getFeeData();
      const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
      // 21000 is the intrinsic cost of a plain value transfer.
      return Number(ethers.formatUnits(gasPrice * 21_000n, spec.nativeDecimals));
    } catch {
      // A failed estimate must not read as "free" — fall back to a pessimistic
      // constant so the reserve maths still leaves something behind.
      return 0.0005;
    }
  }

  private async audit(userId: string, action: string, target: string, payload: unknown) {
    try {
      await this.prisma.auditLog.create({
        data: { userId, action, target, payload: payload as any },
      });
    } catch (e: any) {
      this.logger.warn(`audit write failed for ${action}: ${e?.message}`);
    }
  }
}

export function summarize(rows: TransferResultRow[]) {
  return {
    total: rows.length,
    sent: rows.filter((r) => r.status === 'sent').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    skipped: rows.filter((r) => r.status === 'skipped').length,
    totalAmount: rows.filter((r) => r.status === 'sent').reduce((s, r) => s + r.amount, 0),
  };
}

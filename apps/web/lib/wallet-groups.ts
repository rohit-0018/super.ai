/**
 * Wallet grouping for the wallets screen.
 *
 * Pure functions, no React — the arithmetic here decides what the user believes
 * they own, so it is kept separate and unit-tested rather than inlined into JSX.
 *
 * Two grouping axes:
 *
 *  - `chain`  — where the wallet lives. Solana wallets are their own group; EVM
 *    wallets share one address across every EVM chain, so they group together
 *    and expose a per-chain balance split inside the row.
 *  - `set`    — user-defined sets derived from the label prefix. `bulk/create`
 *    with prefix "Sniper" produces "Sniper 1…N", which becomes a "Sniper" set
 *    with no schema change and no extra bookkeeping.
 *
 * A single `walletUsd()` is the only place that decides how a balance is valued
 * under the current network scope. The header total, the group totals, and the
 * per-row figure all call it, so they cannot disagree — the class of bug where
 * a summary says $19,086 and the rows beneath it add up to something else.
 */

export type GroupMode = 'chain' | 'set' | 'none';

export interface WalletLike {
  id: string;
  chain: 'SOLANA' | 'EVM';
  address: string;
  label?: string;
  isPrimary?: boolean;
  isImported?: boolean;
  backedUpAt?: string | null;
}

export interface ChainSplit {
  chain: string;
  chainName: string;
  symbol: string;
  native: number;
  usd: number;
  explorerUrl: string;
  error?: string;
}

export interface BalanceLike {
  walletId: string;
  native: number;
  symbol: string;
  usd: number;
  chains?: ChainSplit[];
  error?: string;
}

export interface WalletGroup<W extends WalletLike = WalletLike> {
  key: string;
  title: string;
  /** Chain key for the badge. Undefined for non-chain groups. */
  chain?: string;
  /**
   * Distinct chains the group actually spans, richest first.
   *
   * A label-derived set can mix chains ("snipe" on Solana, "snipe-bnb" on EVM),
   * so a single `chain` is not enough to identify it. This lists the chains
   * where members genuinely hold value, falling back to the family when the set
   * is empty — otherwise a freshly created, unfunded set would show no chain at
   * all, which is exactly when you most need to know what it is.
   */
  chains: string[];
  wallets: W[];
  totalUsd: number;
  /** Wallets holding a non-zero balance under the current scope. */
  fundedCount: number;
  /** True when at least one wallet in the group still needs a key backup. */
  needsBackup: boolean;
}

/**
 * USD value of one wallet under the active network scope.
 *
 * Scoped to a single network, only that chain's slice counts — otherwise the
 * header would claim a total the visible rows do not support. EVM wallets carry
 * a `chains` split; Solana balances do not, so they fall back to the flat
 * figure and are excluded when the scope is a non-Solana chain.
 */
export function walletUsd(
  bal: BalanceLike | undefined,
  wallet: WalletLike,
  network: string,
  isAll: boolean,
): number {
  if (!bal || bal.error) return 0;
  if (isAll) return bal.usd ?? 0;

  // Solana wallets have no per-chain split; they only count on the Solana scope.
  if (wallet.chain === 'SOLANA') return network === 'solana' ? bal.usd ?? 0 : 0;

  // EVM without a split (older payload / fallback path) — cannot attribute it
  // to one chain, so report 0 rather than overstating the scoped total.
  if (!bal.chains) return 0;

  return bal.chains.find((c) => c.chain === network)?.usd ?? 0;
}

/** True when the wallet can hold funds on the scoped network at all. */
export function walletOnNetwork(wallet: WalletLike, network: string, isAll: boolean): boolean {
  if (isAll) return true;
  return network === 'solana' ? wallet.chain === 'SOLANA' : wallet.chain === 'EVM';
}

/**
 * Derives a set name from a label by stripping a trailing index.
 * "Sniper 3" → "Sniper", "Treasury" → "Treasury", "" → null.
 */
export function setNameFromLabel(label?: string | null): string | null {
  if (!label) return null;
  const trimmed = label.trim();
  if (!trimmed) return null;
  // Strip a trailing number, and any separator immediately before it.
  const stripped = trimmed.replace(/[\s\-_#]*\d+$/, '').trim();
  return stripped || trimmed;
}

export interface GroupOptions {
  mode: GroupMode;
  network: string;
  isAll: boolean;
}

/**
 * Buckets wallets and computes per-group totals.
 * Groups are ordered by value (richest first), with empty groups last, so the
 * screen leads with where the money actually is.
 */
export function groupWallets<W extends WalletLike>(
  wallets: W[],
  balances: Map<string, BalanceLike>,
  { mode, network, isAll }: GroupOptions,
): WalletGroup<W>[] {
  if (!wallets.length) return [];

  const build = (key: string, title: string, members: W[], chain?: string): WalletGroup<W> => {
    let totalUsd = 0;
    let fundedCount = 0;
    let needsBackup = false;
    const chainValue = new Map<string, number>();
    let hasSolana = false;
    let hasEvm = false;

    for (const w of members) {
      const bal = balances.get(w.id);
      const usd = walletUsd(bal, w, network, isAll);
      totalUsd += usd;
      if (usd > 0) fundedCount++;
      // Imported wallets are backed up by definition — the user already holds the key.
      if (!w.backedUpAt && !w.isImported) needsBackup = true;

      if (w.chain === 'SOLANA') {
        hasSolana = true;
        if ((bal?.usd ?? 0) > 0) {
          chainValue.set('solana', (chainValue.get('solana') ?? 0) + (bal?.usd ?? 0));
        }
      } else {
        hasEvm = true;
        for (const c of bal?.chains ?? []) {
          if (c.native > 0) chainValue.set(c.chain, (chainValue.get(c.chain) ?? 0) + c.usd);
        }
      }
    }

    let chains = [...chainValue.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c]) => c);

    if (!chains.length) {
      // Nothing funded yet — identify the set by what it *can* hold instead.
      if (hasSolana) chains.push('solana');
      if (hasEvm) chains.push(!isAll && network !== 'solana' ? network : 'ethereum');
    }

    return { key, title, chain, chains, wallets: members, totalUsd, fundedCount, needsBackup };
  };

  let groups: WalletGroup<W>[];

  if (mode === 'none') {
    groups = [build('all', 'All wallets', wallets)];
  } else if (mode === 'chain') {
    const solana = wallets.filter((w) => w.chain === 'SOLANA');
    const evm = wallets.filter((w) => w.chain === 'EVM');
    groups = [];
    if (solana.length) groups.push(build('chain:solana', 'Solana', solana, 'solana'));
    if (evm.length) {
      // Scoped to one EVM chain, name the group for that chain — the rows are
      // showing that chain's balance, so calling it "EVM" would be vague.
      const scopedEvm = !isAll && network !== 'solana';
      groups.push(
        build(
          'chain:evm',
          scopedEvm ? chainTitle(network) : 'EVM',
          evm,
          scopedEvm ? network : 'ethereum',
        ),
      );
    }
  } else {
    // mode === 'set'
    const bySet = new Map<string, W[]>();
    for (const w of wallets) {
      const name = setNameFromLabel(w.label) ?? 'Ungrouped';
      const list = bySet.get(name) ?? [];
      list.push(w);
      bySet.set(name, list);
    }

    // A "set" of one is not a set — it is a loose wallet. Folding singletons
    // into Ungrouped stops the screen fragmenting into 20 one-row sections.
    const loose: W[] = [];
    const named: Array<[string, W[]]> = [];
    for (const [name, members] of bySet) {
      if (name === 'Ungrouped' || members.length < 2) loose.push(...members);
      else named.push([name, members]);
    }

    groups = named.map(([name, members]) => build(`set:${name}`, name, members));
    if (loose.length) groups.push(build('set:__loose', 'Ungrouped', loose));
  }

  return groups.sort((a, b) => {
    // Ungrouped always sinks to the bottom regardless of value.
    if (a.key === 'set:__loose') return 1;
    if (b.key === 'set:__loose') return -1;
    if (b.totalUsd !== a.totalUsd) return b.totalUsd - a.totalUsd;
    return a.title.localeCompare(b.title);
  });
}

const CHAIN_TITLES: Record<string, string> = {
  solana: 'Solana',
  ethereum: 'Ethereum',
  bsc: 'BNB Chain',
  base: 'Base',
  arbitrum: 'Arbitrum',
  polygon: 'Polygon',
  avalanche: 'Avalanche',
  optimism: 'Optimism',
  blast: 'Blast',
};

export function chainTitle(chain: string): string {
  return CHAIN_TITLES[chain] ?? chain;
}

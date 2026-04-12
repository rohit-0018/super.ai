'use client';
import { useApi } from '../lib/useApi';
import { Skeleton, SkeletonRow } from './ui/Skeleton';

interface Wallet {
  id: string;
  chain: 'SOLANA' | 'EVM';
  address: string;
  isPrimary?: boolean;
}

interface WalletBalance {
  walletId: string;
  native: number;
  symbol: string;
  usd: number;
}

export default function PortfolioCard() {
  const { data: wallets, loading } = useApi<Wallet[]>('/wallets');
  const { data: balances, loading: balLoading } = useApi<WalletBalance[]>('/wallets/balances');
  const balMap = new Map<string, WalletBalance>();
  balances?.forEach((b) => balMap.set(b.walletId, b));
  const totalUsd = balances?.reduce((s, b) => s + (b.usd ?? 0), 0) ?? 0;

  return (
    <div className="panel">
      <div className="flex items-center justify-between mb-5">
        <h3 className="section-title">Portfolio</h3>
        {loading ? (
          <Skeleton w={60} h={20} rounded="md" />
        ) : (
          <span className="chip">
            {(wallets ?? []).length} wallet{(wallets ?? []).length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="mb-5">
        <div className="stat-label mb-1">Total value</div>
        {balLoading && !balances ? (
          <Skeleton w={140} h={28} rounded="md" />
        ) : (
          <div className="stat-value fade-in">
            ${totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        )}
      </div>

      <hr className="divider mb-4" />

      {loading && !wallets ? (
        <div className="space-y-3">
          <SkeletonRow cols={3} />
          <SkeletonRow cols={3} />
        </div>
      ) : !wallets || wallets.length === 0 ? (
        <div className="py-4">
          <p className="text-[13px] text-[color:var(--text-3)] mb-2">No wallets connected yet</p>
          <a href="/wallets" className="link text-[12px]">+ Create your first wallet</a>
        </div>
      ) : (
        <ul className="space-y-2.5 fade-in">
          {wallets.map((w) => {
            const bal = balMap.get(w.id);
            return (
              <li key={w.id} className="flex items-center justify-between text-[13px]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="chip">{w.chain === 'SOLANA' ? 'SOL' : 'EVM'}</span>
                  {w.isPrimary && (
                    <span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: 'var(--accent)' }}>
                      Primary
                    </span>
                  )}
                </div>
                <div className="text-right">
                  {bal ? (
                    <span className="font-mono text-[13px]">
                      {bal.native.toLocaleString(undefined, { maximumFractionDigits: 4 })} {bal.symbol}
                      <span className="text-[color:var(--text-3)] ml-1.5 text-[11px]">${bal.usd.toFixed(2)}</span>
                    </span>
                  ) : balLoading ? (
                    <Skeleton w={80} h={12} />
                  ) : (
                    <span className="font-mono text-[color:var(--text-3)] text-[12px]">
                      {w.address.slice(0, 6)}…{w.address.slice(-4)}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Skeleton, SkeletonRow } from './ui/Skeleton';

interface Wallet {
  id: string;
  chain: 'SOLANA' | 'EVM';
  address: string;
  isPrimary?: boolean;
  balanceUsd?: number;
}

export default function PortfolioCard() {
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get<Wallet[]>('/wallets');
        if (!cancelled) setWallets(Array.isArray(data) ? data : []);
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message ?? 'Failed to load');
          setWallets([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loading = wallets === null;
  const totalUsd = wallets?.reduce((s, w) => s + (w.balanceUsd ?? 0), 0) ?? 0;

  return (
    <div className="panel">
      <div className="flex items-center justify-between mb-5">
        <h3 className="section-title">Portfolio</h3>
        {loading ? (
          <Skeleton w={60} h={20} rounded="md" />
        ) : (
          <span className="chip">
            {wallets!.length} wallet{wallets!.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="mb-5">
        <div className="stat-label mb-1">Total value</div>
        {loading ? (
          <Skeleton w={140} h={28} rounded="md" />
        ) : (
          <div className="stat-value fade-in">
            ${totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        )}
      </div>

      <hr className="divider mb-4" />

      {loading ? (
        <div className="space-y-3">
          <SkeletonRow cols={3} />
          <SkeletonRow cols={3} />
        </div>
      ) : error ? (
        <p className="text-[13px] text-[color:var(--bad)]">{error}</p>
      ) : wallets!.length === 0 ? (
        <div className="py-4">
          <p className="text-[13px] text-[color:var(--text-3)] mb-2">No wallets connected yet</p>
          <a href="/wallets" className="link text-[12px]">+ Create your first wallet</a>
        </div>
      ) : (
        <ul className="space-y-2.5 fade-in">
          {wallets!.map((w) => (
            <li key={w.id} className="flex items-center justify-between text-[13px]">
              <div className="flex items-center gap-2 min-w-0">
                <span className="chip">{w.chain === 'SOLANA' ? 'SOL' : 'EVM'}</span>
                {w.isPrimary && (
                  <span
                    className="text-[10px] uppercase tracking-wider font-medium"
                    style={{ color: 'var(--accent)' }}
                  >
                    Primary
                  </span>
                )}
              </div>
              <span className="font-mono text-[color:var(--text-2)] truncate ml-3">
                {w.address.slice(0, 6)}…{w.address.slice(-4)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function PortfolioCard() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    api.get('/wallets').then((r) => setData(r.data)).catch(() => setData([]));
  }, []);

  return (
    <div className="panel">
      <div className="flex items-center justify-between mb-5">
        <h3 className="section-title">Portfolio</h3>
        <span className="chip">{data?.length ?? 0} wallet{data?.length === 1 ? '' : 's'}</span>
      </div>

      <div className="mb-5">
        <div className="stat-label mb-1">Total value</div>
        <div className="stat-value">$0.00</div>
      </div>

      <hr className="divider mb-4" />

      {!data ? (
        <p className="text-[13px] text-[color:var(--text-3)]">Loading…</p>
      ) : data.length === 0 ? (
        <p className="text-[13px] text-[color:var(--text-3)]">No wallets connected yet</p>
      ) : (
        <ul className="space-y-2.5">
          {data.map((w: any) => (
            <li key={w.id} className="flex items-center justify-between text-[13px]">
              <span className="chip">{w.chain}</span>
              <span className="font-mono text-[color:var(--text-2)]">
                {w.address.slice(0, 6)}…{w.address.slice(-4)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

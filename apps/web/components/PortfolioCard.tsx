'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function PortfolioCard() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api.get('/wallets').then((r) => setData(r.data)).catch(() => setData([])); }, []);
  return (
    <div className="panel">
      <h3 className="font-bold mb-2">Portfolio</h3>
      {!data ? <p className="opacity-50 text-sm">Loading…</p> : (
        <ul className="text-sm space-y-1">
          {data.length === 0 && <li className="opacity-50">No wallets yet</li>}
          {data.map((w: any) => (
            <li key={w.id}><span className="opacity-50">{w.chain}</span> {w.address.slice(0, 6)}…{w.address.slice(-4)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

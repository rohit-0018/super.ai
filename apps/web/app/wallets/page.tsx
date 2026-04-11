'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

export default function Wallets() {
  const [wallets, setWallets] = useState<any[]>([]);
  const refresh = () => api.get('/wallets').then((r) => setWallets(r.data));
  useEffect(() => { refresh().catch(() => {}); }, []);
  async function create(chain: 'SOLANA' | 'EVM') {
    await api.post('/wallets', { chain });
    refresh();
  }
  async function exportKey(id: string) {
    const { data } = await api.post(`/wallets/${id}/export`, {});
    alert('Private key (store offline):\n\n' + data.key);
  }
  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Wallets</h1>
          <p className="text-[13px] text-[color:var(--text-2)] mt-1">
            Manage connected wallets across Solana and EVM chains.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => create('SOLANA')} className="btn">+ Solana</button>
          <button onClick={() => create('EVM')} className="btn">+ EVM</button>
        </div>
      </header>

      <div className="panel !p-0 overflow-hidden">
        {wallets.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-[13px] text-[color:var(--text-3)]">No wallets yet</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {wallets.map((w) => (
              <li key={w.id} className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="chip">{w.chain}</span>
                  <span className="font-mono text-[13px] text-[color:var(--text-2)] truncate">
                    {w.address}
                  </span>
                </div>
                <button
                  onClick={() => exportKey(w.id)}
                  className="btn btn-sm"
                  style={{ color: 'var(--bad)' }}
                >
                  Export key
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

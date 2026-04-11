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
    <div className="panel">
      <h1 className="text-2xl font-bold mb-4">Wallets</h1>
      <div className="flex gap-2 mb-4">
        <button onClick={() => create('SOLANA')} className="bg-accent text-black px-3 py-1 rounded">+ Solana</button>
        <button onClick={() => create('EVM')} className="bg-accent text-black px-3 py-1 rounded">+ EVM</button>
      </div>
      <ul className="space-y-2">
        {wallets.map((w) => (
          <li key={w.id} className="flex items-center justify-between border border-[#1c2540] rounded p-2">
            <span><b>{w.chain}</b> {w.address}</span>
            <button onClick={() => exportKey(w.id)} className="text-bad text-sm">Export Key</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

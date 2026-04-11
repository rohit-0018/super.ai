'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

export default function Settings() {
  const [g, setG] = useState<any>(null);
  useEffect(() => { api.get('/guardrails').then((r) => setG(r.data)).catch(() => setG({})); }, []);
  async function save() { await api.post('/guardrails', g); alert('Saved'); }
  async function killSwitch() { await api.post('/guardrails/kill', {}); alert('Kill switch ENGAGED'); }
  if (!g) return <p>Loading…</p>;
  return (
    <div className="panel max-w-xl">
      <h2 className="font-bold text-xl mb-4">Guardrails</h2>
      <div className="grid gap-3 text-sm">
        <label>Per-trade USD <input type="number" value={g.perTradeUsd ?? 0} onChange={(e) => setG({ ...g, perTradeUsd: +e.target.value })} className="bg-bg border border-[#1c2540] px-2 py-1 rounded ml-2" /></label>
        <label>Daily USD <input type="number" value={g.dailyUsd ?? 0} onChange={(e) => setG({ ...g, dailyUsd: +e.target.value })} className="bg-bg border border-[#1c2540] px-2 py-1 rounded ml-2" /></label>
        <label>Max slippage (bps) <input type="number" value={g.maxSlippageBps ?? 0} onChange={(e) => setG({ ...g, maxSlippageBps: +e.target.value })} className="bg-bg border border-[#1c2540] px-2 py-1 rounded ml-2" /></label>
        <button onClick={save} className="bg-accent text-black py-2 rounded font-bold">Save</button>
        <button onClick={killSwitch} className="bg-bad text-white py-2 rounded font-bold">🚨 Engage Kill Switch</button>
      </div>
    </div>
  );
}

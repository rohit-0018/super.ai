'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function SwapForm() {
  const [wallets, setWallets] = useState<any[]>([]);
  const [walletId, setWalletId] = useState('');
  const [chain, setChain] = useState<'SOLANA' | 'EVM'>('SOLANA');
  const [tokenIn, setTokenIn] = useState('');
  const [tokenOut, setTokenOut] = useState('');
  const [amountIn, setAmountIn] = useState('');
  const [notionalUsd, setNotionalUsd] = useState(100);
  const [slippageBps, setSlippageBps] = useState(100);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.get('/wallets').then((r) => {
      setWallets(r.data);
      const primary = r.data.find((w: any) => w.isPrimary) ?? r.data[0];
      if (primary) {
        setWalletId(primary.id);
        setChain(primary.chain);
      }
    }).catch(() => {});
  }, []);

  async function submit() {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const { data } = await api.post('/swap', {
        walletId,
        chain,
        tokenIn,
        tokenOut,
        amountIn,
        notionalUsd,
        slippageBps,
      });
      setResult(`Trade ${data.tradeId} — mode ${data.mode}`);
    } catch (e: any) {
      setErr(e.response?.data?.message?.guardrail ?? e.response?.data?.message ?? e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="flex items-center justify-between mb-5">
        <h3 className="section-title">Swap</h3>
        <span className="chip">{chain}</span>
      </div>

      <div className="space-y-3">
        <div>
          <label className="label">Wallet</label>
          <select value={walletId} onChange={(e) => setWalletId(e.target.value)} className="input">
            {wallets.length === 0 && <option value="">No wallets connected</option>}
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.chain} · {w.address.slice(0, 10)}…
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label">From</label>
          <input
            placeholder="Token in (mint or contract)"
            value={tokenIn}
            onChange={(e) => setTokenIn(e.target.value)}
            className="input font-mono"
          />
        </div>

        <div>
          <label className="label">To</label>
          <input
            placeholder="Token out"
            value={tokenOut}
            onChange={(e) => setTokenOut(e.target.value)}
            className="input font-mono"
          />
        </div>

        <div>
          <label className="label">Amount</label>
          <input
            placeholder="Base units"
            value={amountIn}
            onChange={(e) => setAmountIn(e.target.value)}
            className="input font-mono"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Notional (USD)</label>
            <input
              type="number"
              value={notionalUsd}
              onChange={(e) => setNotionalUsd(+e.target.value)}
              className="input font-mono"
            />
          </div>
          <div>
            <label className="label">Slippage (bps)</label>
            <input
              type="number"
              value={slippageBps}
              onChange={(e) => setSlippageBps(+e.target.value)}
              className="input font-mono"
            />
          </div>
        </div>

        <button onClick={submit} disabled={busy || !walletId} className="btn btn-primary w-full mt-2">
          {busy ? 'Submitting…' : 'Review swap'}
        </button>

        {result && (
          <p className="text-[13px] text-[color:var(--ok)] font-mono pt-1">{result}</p>
        )}
        {err && <p className="text-[13px] text-[color:var(--bad)] pt-1">{err}</p>}
      </div>
    </div>
  );
}

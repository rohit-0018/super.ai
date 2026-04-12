'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { Spinner } from './ui/Skeleton';
import AdvancedOrderBuilder from './AdvancedOrderBuilder';

interface Wallet { id: string; chain: 'SOLANA' | 'EVM'; address: string; isPrimary?: boolean }

export default function SwapForm() {
  const { data: wallets = [] } = useApi<Wallet[]>('/wallets');
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
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (walletId || !wallets.length) return;
    const primary = wallets.find((w) => w.isPrimary) ?? wallets[0];
    setWalletId(primary.id);
    setChain(primary.chain);
  }, [wallets, walletId]);

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
      {advancedOpen && <AdvancedOrderBuilder onClose={() => setAdvancedOpen(false)} />}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="section-title mb-0.5">Swap</h3>
          <div className="text-[11px] text-[color:var(--text-3)]">Market order · route via Jupiter / 1inch</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="chip">{chain}</span>
          <button
            type="button"
            onClick={() => setAdvancedOpen(true)}
            className="btn btn-sm"
            title="Limit, stop, trailing, bracket, DCA"
          >
            Advanced
          </button>
        </div>
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
          {busy ? <Spinner size={14} /> : 'Review swap'}
        </button>

        {result && (
          <p className="text-[13px] text-[color:var(--ok)] font-mono pt-1">{result}</p>
        )}
        {err && <p className="text-[13px] text-[color:var(--bad)] pt-1">{err}</p>}
      </div>
    </div>
  );
}

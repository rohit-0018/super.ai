'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Skeleton } from './ui/Skeleton';

interface BalanceRow {
  asset: string;
  free: number;
  locked?: number;
  valueUsd?: number;
}

type PortfolioResponse = Record<string, BalanceRow[] | { error: string }>;

const EXCHANGES = ['BINANCE', 'BYBIT', 'OKX'] as const;

export default function CexPortfolio() {
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<PortfolioResponse>('/cex/portfolio')
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch(() => { if (!cancelled) setData({}); })
      .finally(() => { if (!cancelled) setLoading(false); });
  }, []);

  const connectedExchanges = data
    ? Object.keys(data).filter((k) => {
        const v = data[k];
        return Array.isArray(v);
      })
    : [];

  const totalUsd = data
    ? Object.values(data).reduce((s, rows) => {
        if (!Array.isArray(rows)) return s;
        return s + rows.reduce((r, b) => r + (b.valueUsd ?? 0), 0);
      }, 0)
    : 0;

  return (
    <div className="panel">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="section-title mb-0.5">Exchanges · CEX</h3>
          <div className="text-[11px] text-[color:var(--text-3)]">
            Read-only aggregated view across Binance / Bybit / OKX
          </div>
        </div>
        <button
          onClick={() => setConnectOpen((v) => !v)}
          className="btn btn-sm"
        >
          {connectOpen ? 'Cancel' : '+ Connect'}
        </button>
      </div>

      {connectOpen && <ConnectForm onDone={() => { setConnectOpen(false); setLoading(true); api.get<PortfolioResponse>('/cex/portfolio').then((r) => setData(r.data)).finally(() => setLoading(false)); }} />}

      {loading ? (
        <div className="space-y-3">
          <div>
            <Skeleton w={120} h={12} className="mb-2" />
            <Skeleton w={180} h={28} />
          </div>
          <hr className="divider my-4" />
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between">
                <Skeleton w={80} h={14} />
                <Skeleton w={100} h={14} />
              </div>
            ))}
          </div>
        </div>
      ) : connectedExchanges.length === 0 ? (
        <div className="py-6 text-center">
          <div className="text-[13px] text-[color:var(--text-3)] mb-2">
            No exchanges connected
          </div>
          <div className="text-[11px] text-[color:var(--text-3)]">
            Read-only API keys. Your funds never leave the exchange.
          </div>
        </div>
      ) : (
        <div className="fade-in">
          <div className="mb-4">
            <div className="stat-label mb-1">Aggregated value</div>
            <div className="stat-value">${totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
          </div>
          <hr className="divider mb-4" />
          <div className="space-y-4">
            {EXCHANGES.map((ex) => {
              const rows = data![ex];
              if (!rows) return null;
              return (
                <div key={ex}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[11px] uppercase tracking-wider font-medium" style={{ color: 'var(--text-2)' }}>
                      {ex}
                    </div>
                    {'error' in rows ? (
                      <span className="chip" style={{ color: 'var(--bad)' }}>error</span>
                    ) : (
                      <span className="chip">{rows.length} asset{rows.length === 1 ? '' : 's'}</span>
                    )}
                  </div>
                  {Array.isArray(rows) ? (
                    <ul className="space-y-1.5">
                      {rows.slice(0, 5).map((b) => (
                        <li key={b.asset} className="flex items-center justify-between text-[12.5px]">
                          <span className="font-mono text-[color:var(--text-2)]">{b.asset}</span>
                          <span className="font-mono">
                            {b.free.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                            {b.valueUsd != null && (
                              <span className="text-[color:var(--text-3)] ml-2">
                                (${b.valueUsd.toFixed(2)})
                              </span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[12px] text-[color:var(--bad)]">{(rows as any).error}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectForm({ onDone }: { onDone: () => void }) {
  const [exchange, setExchange] = useState<'BINANCE' | 'BYBIT' | 'OKX'>('BINANCE');
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await api.post('/cex', { exchange, apiKey, secret, passphrase: passphrase || undefined });
      onDone();
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to connect');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mb-4 p-4 rounded-lg"
      style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="label">Exchange</label>
          <select
            value={exchange}
            onChange={(e) => setExchange(e.target.value as any)}
            className="input"
          >
            <option value="BINANCE">Binance</option>
            <option value="BYBIT">Bybit</option>
            <option value="OKX">OKX (needs passphrase)</option>
          </select>
        </div>
        <div>
          <label className="label">API key</label>
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Read-only key" className="input font-mono" />
        </div>
        <div>
          <label className="label">Secret</label>
          <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="••••••" type="password" className="input font-mono" />
        </div>
        {exchange === 'OKX' && (
          <div>
            <label className="label">Passphrase</label>
            <input value={passphrase} onChange={(e) => setPassphrase(e.target.value)} type="password" className="input font-mono" />
          </div>
        )}
      </div>
      {err && <p className="text-[12px] text-[color:var(--bad)] mt-3">{err}</p>}
      <div className="flex gap-2 mt-4">
        <button onClick={submit} disabled={busy || !apiKey || !secret} className="btn btn-primary btn-sm">
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </div>
  );
}

'use client';
import { useState } from 'react';
import { api } from '../lib/api';
import { Skeleton, Spinner } from './ui/Skeleton';

interface IntelResponse {
  chain?: string;
  address?: string;
  symbol?: string;
  name?: string;
  convictionScore?: number;
  securityScore?: number;
  priceUsd?: number;
}

export default function TokenIntelCard() {
  const [input, setInput] = useState('');
  const [chain, setChain] = useState<'SOLANA' | 'EVM'>('SOLANA');
  const [intel, setIntel] = useState<IntelResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function analyze() {
    if (!input.trim()) return;
    setLoading(true);
    setErr(null);
    setIntel(null);
    try {
      const { data } = await api.post('/token-intel/analyze', { address: input.trim(), chain });
      setIntel(data);
    } catch (e: any) {
      setErr(e.response?.data?.message ?? e.message);
    } finally {
      setLoading(false);
    }
  }

  const conviction = intel?.convictionScore;
  const convictionColor =
    conviction == null
      ? ''
      : conviction >= 7
      ? 'text-[color:var(--ok)]'
      : conviction >= 4
      ? 'text-[color:var(--warn)]'
      : 'text-[color:var(--bad)]';

  return (
    <div className="panel">
      <div className="flex items-center justify-between mb-4">
        <h3 className="section-title">Token intel</h3>
        <div className="flex gap-0.5 p-0.5 rounded-md bg-[color:var(--surface-2)] border border-border">
          {(['SOLANA', 'EVM'] as const).map((c) => (
            <button
              key={c}
              onClick={() => setChain(c)}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                chain === c
                  ? 'bg-[color:var(--surface)] text-text shadow-sm'
                  : 'text-[color:var(--text-2)] hover:text-text'
              }`}
            >
              {c === 'SOLANA' ? 'SOL' : 'EVM'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && analyze()}
          placeholder="Contract or ticker"
          className="input font-mono"
        />
        <button onClick={analyze} disabled={loading || !input.trim()} className="btn btn-primary">
          {loading ? <Spinner size={12} /> : 'Analyze'}
        </button>
      </div>

      {err && <p className="text-[13px] text-[color:var(--bad)] mb-2">{err}</p>}

      {loading && !intel && (
        <div className="space-y-3 pt-1">
          <div className="flex items-baseline justify-between">
            <Skeleton w={80} h={18} />
            <Skeleton w={90} h={14} />
          </div>
          <hr className="divider" />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5"><Skeleton w={60} h={10} /><Skeleton w={50} h={16} /></div>
            <div className="space-y-1.5"><Skeleton w={60} h={10} /><Skeleton w={50} h={16} /></div>
          </div>
        </div>
      )}

      {intel && (
        <div className="space-y-4 pt-1">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="text-base font-semibold">{intel.symbol ?? '?'}</div>
              {intel.name && <div className="text-[12px] text-[color:var(--text-3)]">{intel.name}</div>}
            </div>
            {intel.priceUsd != null && (
              <div className="font-mono text-[15px]">${intel.priceUsd.toFixed(6)}</div>
            )}
          </div>
          <hr className="divider" />
          <div className="grid grid-cols-2 gap-4">
            {intel.securityScore != null && (
              <div>
                <div className="stat-label mb-1">Security</div>
                <div className="font-mono text-[15px]">
                  {intel.securityScore.toFixed(1)}
                  <span className="text-[color:var(--text-3)]">/10</span>
                </div>
              </div>
            )}
            {conviction != null && (
              <div>
                <div className="stat-label mb-1">Conviction</div>
                <div className={`font-mono text-[15px] font-semibold ${convictionColor}`}>
                  {conviction.toFixed(1)}
                  <span className="text-[color:var(--text-3)] font-normal">/10</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

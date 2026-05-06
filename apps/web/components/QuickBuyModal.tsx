'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { Spinner } from './ui/Skeleton';

interface Wallet { id: string; chain: 'SOLANA' | 'EVM'; address: string; isPrimary?: boolean }

export interface QuickBuyModalProps {
  address?: string;
  symbol?: string | null;
  chain?: 'SOLANA' | 'EVM';
  mode?: 'buy' | 'sell';
  onClose: () => void;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USD_PRESETS = [10, 25, 50, 100, 500];
const SLIP = [{ label: '1%', bps: 100 }, { label: '3%', bps: 300 }, { label: '5%', bps: 500 }, { label: '10%', bps: 1000 }];

export function QuickBuyModal({ address: initAddress, symbol, chain = 'SOLANA', mode = 'buy', onClose }: QuickBuyModalProps) {
  const { data: rawWallets } = useApi<Wallet[]>('/wallets');
  const wallets: Wallet[] = Array.isArray(rawWallets) ? rawWallets : [];

  const [addr, setAddr] = useState(initAddress ?? '');
  const [walletId, setWalletId] = useState('');
  const [usd, setUsd] = useState(50);
  const [slipBps, setSlipBps] = useState(300);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (walletId || !wallets.length) return;
    const w = wallets.find((w) => w.isPrimary && w.chain === chain)
      ?? wallets.find((w) => w.chain === chain)
      ?? wallets[0];
    if (w) setWalletId(w.id);
  }, [wallets, walletId, chain]);

  async function submit() {
    if (!addr.trim()) { setErr('Enter a token address'); return; }
    setBusy(true); setErr(null); setDone(null);
    try {
      const isBuy = mode === 'buy';
      const { data } = await api.post('/swap', {
        walletId,
        chain,
        tokenIn:  isBuy ? SOL_MINT : addr.trim(),
        tokenOut: isBuy ? addr.trim() : SOL_MINT,
        amountIn: '',
        notionalUsd: usd,
        slippageBps: slipBps,
      });
      setDone(`Trade ${data.tradeId} placed ✓`);
    } catch (e: any) {
      const d = e.response?.data;
      const msg = d?.guardrail ?? d?.reasons?.join(', ') ?? d?.message ?? e.message;
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  const isBuy = mode === 'buy';
  const accentColor = isBuy ? 'var(--ok)' : 'var(--bad)';
  const label = isBuy ? '⚡ Buy' : '💰 Sell';
  const tokenLabel = symbol ? `$${symbol}` : (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : 'token');

  return (
    <div
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380, maxWidth: '94vw',
          background: 'var(--surface)',
          border: `1px solid color-mix(in srgb, ${accentColor} 35%, var(--border))`,
          borderRadius: 18, padding: 26,
          display: 'flex', flexDirection: 'column', gap: 20,
          boxShadow: `0 0 60px rgba(0,0,0,0.7), 0 0 120px color-mix(in srgb, ${accentColor} 8%, transparent)`,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em' }}>
              {label} {tokenLabel}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
              {isBuy ? 'Market buy via Jupiter' : 'Market sell via Jupiter'}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: '0 4px' }}
          >
            ×
          </button>
        </div>

        {/* Address input — shown when no address pre-filled */}
        {!initAddress && (
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
              Token Address
            </div>
            <input
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              placeholder="Paste contract / mint address…"
              className="input font-mono"
              style={{ fontSize: 12 }}
              autoFocus
            />
          </div>
        )}

        {/* Wallet */}
        {wallets.length > 1 && (
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Wallet</div>
            <select value={walletId} onChange={(e) => setWalletId(e.target.value)} className="input" style={{ fontSize: 12 }}>
              {wallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.chain} · {w.address.slice(0, 6)}…{w.address.slice(-4)}{w.isPrimary ? ' (primary)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* USD amount */}
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
            {isBuy ? 'Buy Amount (USD)' : 'Sell Amount (USD)'}
          </div>
          <div style={{ display: 'flex', gap: 5, marginBottom: 10 }}>
            {USD_PRESETS.map((p) => (
              <button
                key={p} type="button" onClick={() => setUsd(p)}
                style={{
                  flex: 1, padding: '7px 0', borderRadius: 8, cursor: 'pointer',
                  border: `1px solid ${usd === p ? accentColor : 'var(--border)'}`,
                  background: usd === p ? `color-mix(in srgb, ${accentColor} 18%, transparent)` : 'var(--surface-2)',
                  color: usd === p ? accentColor : 'var(--text-2)',
                  fontSize: 11, fontWeight: 700,
                }}
              >
                ${p}
              </button>
            ))}
          </div>
          <input
            type="number" min={1} value={usd}
            onChange={(e) => setUsd(Number(e.target.value))}
            className="input font-mono"
            style={{ fontSize: 24, fontWeight: 800, textAlign: 'center', height: 56 }}
          />
        </div>

        {/* Slippage */}
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Slippage</div>
          <div style={{ display: 'flex', gap: 5 }}>
            {SLIP.map((s) => (
              <button
                key={s.bps} type="button" onClick={() => setSlipBps(s.bps)}
                style={{
                  flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer',
                  border: `1px solid ${slipBps === s.bps ? accentColor : 'var(--border)'}`,
                  background: slipBps === s.bps ? `color-mix(in srgb, ${accentColor} 18%, transparent)` : 'var(--surface-2)',
                  color: slipBps === s.bps ? accentColor : 'var(--text-2)',
                  fontSize: 12, fontWeight: 700,
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* CTA */}
        {done ? (
          <div style={{ textAlign: 'center', padding: '10px 0', color: 'var(--ok)', fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700 }}>
            ✓ {done}
          </div>
        ) : (
          <button
            type="button" onClick={submit} disabled={busy || !walletId}
            style={{
              padding: '15px', borderRadius: 12, border: 'none', cursor: busy ? 'wait' : 'pointer',
              background: `linear-gradient(135deg, ${accentColor} 0%, color-mix(in srgb, ${accentColor} 65%, black) 100%)`,
              color: 'white', fontSize: 15, fontWeight: 800,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              boxShadow: `0 0 30px color-mix(in srgb, ${accentColor} 25%, transparent)`,
              opacity: busy || !walletId ? 0.65 : 1,
              letterSpacing: '0.02em',
            }}
          >
            {busy ? <Spinner size={18} /> : `${label} $${usd}`}
          </button>
        )}

        {err && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--bad)', textAlign: 'center' }}>{err}</p>
        )}
      </div>
    </div>
  );
}

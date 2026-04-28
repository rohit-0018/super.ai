'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';
import { invalidate } from '../lib/useApi';
import { Spinner } from './ui/Skeleton';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface SellModalToken {
  mint: string;
  symbol: string;
  amount: number;
  decimals: number;
  priceUsd: number | null;
}

interface Props {
  walletId: string;
  walletChain: 'SOLANA' | 'EVM';
  token: SellModalToken;
  onClose: () => void;
}

const SLIPPAGE_OPTIONS = [
  { label: '0.5%', bps: 50 },
  { label: '1%', bps: 100 },
  { label: '3%', bps: 300 },
  { label: '5%', bps: 500 },
];

const PCT_PRESETS = [25, 50, 75, 100];

export default function SellTokenModal({ walletId, walletChain, token, onClose }: Props) {
  const [pct, setPct] = useState(100);
  const [slippageBps, setSlippageBps] = useState(100);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tradeId: string; mode: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const sellAmount = (token.amount * pct) / 100;
  const proceedsUsd = token.priceUsd !== null ? sellAmount * token.priceUsd : null;
  const amountInRaw = bigIntFromDecimal(sellAmount, token.decimals);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function submit() {
    if (sellAmount <= 0) {
      setErr('Amount must be greater than zero');
      return;
    }
    if (walletChain !== 'SOLANA') {
      setErr('Only Solana sells are supported from the portfolio for now');
      return;
    }
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const { data } = await api.post<{ tradeId: string; mode: string }>('/swap', {
        walletId,
        chain: 'SOLANA',
        tokenIn: token.mint,
        tokenOut: WSOL_MINT,
        amountIn: amountInRaw,
        notionalUsd: proceedsUsd ?? 0,
        slippageBps,
      });
      setResult(data);
      // Refresh portfolio, trades, snipe activity, and wallets list so every
      // surface that shows a buy/sell row reflects this sell.
      invalidate(`/wallets/${walletId}/holdings`);
      invalidate('/wallets/balances');
      invalidate('/wallets');
      invalidate('/trades');
      invalidate('/snipe/activity?limit=100');
    } catch (e: any) {
      setErr(
        e?.response?.data?.message?.guardrail ??
          e?.response?.data?.message ??
          e?.message ??
          'Sell failed',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={() => !busy && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'color-mix(in srgb, #000 65%, transparent)',
        backdropFilter: 'blur(4px)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel"
        style={{
          width: '100%',
          maxWidth: 440,
          padding: 0,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div className="section-eyebrow" style={{ fontSize: 10 }}>
              Sell position
            </div>
            <div className="text-[15px] font-semibold" style={{ marginTop: 2 }}>
              {token.symbol}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="btn btn-ghost"
            style={{ padding: '4px 10px', fontSize: 16, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {!result ? (
          <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Position summary */}
            <div
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '10px 12px',
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 10,
              }}
            >
              <div>
                <div className="text-[10px]" style={{ color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Amount held
                </div>
                <div className="font-mono text-[12px] font-semibold" style={{ marginTop: 2 }}>
                  {fmtAmount(token.amount, token.decimals)}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="text-[10px]" style={{ color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Current price
                </div>
                <div className="font-mono text-[12px] font-semibold" style={{ marginTop: 2 }}>
                  {token.priceUsd !== null ? fmtUsd(token.priceUsd) : '—'}
                </div>
              </div>
            </div>

            {/* Percentage selector */}
            <div>
              <label className="label">Sell amount</label>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                {PCT_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPct(p)}
                    disabled={busy}
                    className={pct === p ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
                    style={{ flex: 1 }}
                  >
                    {p}%
                  </button>
                ))}
              </div>
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                value={pct}
                onChange={(e) => setPct(parseInt(e.target.value, 10))}
                disabled={busy}
                style={{ width: '100%', accentColor: 'var(--accent)' }}
              />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginTop: 6,
                  fontSize: 11,
                  color: 'var(--text-3)',
                }}
              >
                <span>1%</span>
                <span className="font-mono" style={{ color: 'var(--text-1)', fontWeight: 600 }}>
                  {pct}% · {fmtAmount(sellAmount, token.decimals)} {token.symbol}
                </span>
                <span>100%</span>
              </div>
            </div>

            {/* Slippage */}
            <div>
              <label className="label">Slippage tolerance</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {SLIPPAGE_OPTIONS.map((o) => (
                  <button
                    key={o.bps}
                    type="button"
                    onClick={() => setSlippageBps(o.bps)}
                    disabled={busy}
                    className={slippageBps === o.bps ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
                    style={{ flex: 1 }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Estimated proceeds */}
            <div
              style={{
                borderTop: '1px solid var(--border)',
                paddingTop: 12,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
              }}
            >
              <span className="text-[11px]" style={{ color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Estimated proceeds
              </span>
              <span className="font-mono text-[16px] font-bold" style={{ color: 'var(--accent)' }}>
                {proceedsUsd !== null ? fmtUsd(proceedsUsd) : '—'}
              </span>
            </div>

            {err && (
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: 'color-mix(in srgb, var(--bad) 15%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--bad) 35%, var(--border))',
                  color: 'var(--bad)',
                  fontSize: 12,
                }}
              >
                {err}
              </div>
            )}

            <button
              onClick={submit}
              disabled={busy || sellAmount <= 0}
              className="btn btn-primary"
              style={{ height: 42, fontSize: 14, fontWeight: 600 }}
            >
              {busy ? <Spinner size={14} /> : `Sell ${pct}% of ${token.symbol}`}
            </button>
            <p className="text-[10px]" style={{ color: 'var(--text-3)', textAlign: 'center', margin: 0 }}>
              Routes via Jupiter · proceeds in SOL · subject to live mode &amp; risk guards.
            </p>
          </div>
        ) : (
          /* Success state */
          <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: 'color-mix(in srgb, var(--ok) 18%, transparent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--ok)',
                fontSize: 22,
                fontWeight: 700,
              }}
            >
              ✓
            </div>
            <div style={{ textAlign: 'center' }}>
              <div className="text-[14px] font-semibold">Sell submitted</div>
              <div className="text-[11px]" style={{ color: 'var(--text-3)', marginTop: 4 }}>
                Mode: {result.mode} · Trade ID
              </div>
              <div className="font-mono text-[11px]" style={{ marginTop: 2 }}>
                {result.tradeId}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, width: '100%' }}>
              <Link href="/trades" className="btn btn-primary" style={{ flex: 1, textAlign: 'center' }}>
                View in Trades
              </Link>
              <button onClick={onClose} className="btn" style={{ flex: 1 }}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Helpers ──────────────────────────────────────────────────── */

// Convert ui amount to base units (string) without losing precision for typical token decimals.
function bigIntFromDecimal(uiAmount: number, decimals: number): string {
  if (!Number.isFinite(uiAmount) || uiAmount <= 0) return '0';
  const [intPart, fracPartRaw = ''] = uiAmount.toFixed(Math.min(decimals, 18)).split('.');
  const fracPart = (fracPartRaw + '0'.repeat(decimals)).slice(0, decimals);
  const combined = (intPart + fracPart).replace(/^0+/, '') || '0';
  return combined;
}

function fmtAmount(n: number, decimals: number): string {
  const dp = n < 1 ? Math.min(6, decimals) : 4;
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  if (Math.abs(n) < 0.01) return `$${n.toExponential(2)}`;
  return `$${n.toFixed(2)}`;
}

'use client';
import { useEffect, useRef, useState } from 'react';
import { useTokenResolve, type Chain, type ResolvedToken } from '../lib/useTokenResolve';

/**
 * Reusable token field: paste a contract address OR type a $TICKER. Ambiguous
 * tickers show a popularity-ranked pick list; a single/address hit auto-selects.
 * The resolved token is surfaced as a confirm chip so the user always sees
 * exactly what they picked before acting on it (critical on trade paths).
 */
export function TokenSearchInput({
  onResolved,
  chain,
  minLiquidityUsd,
  placeholder = 'Paste an address or type $TICKER',
  label = 'Token',
  autoFocus,
  disabled,
}: {
  onResolved: (token: ResolvedToken | null) => void;
  chain?: Chain;
  minLiquidityUsd?: number;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState<ResolvedToken | null>(null);
  const [showList, setShowList] = useState(false);
  const { resolve, reset, result, loading, error } = useTokenResolve();
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced resolve as the user types.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (selected) return; // already locked in — don't keep querying
    const q = value.trim();
    if (!q) {
      reset();
      setShowList(false);
      return;
    }
    debounce.current = setTimeout(() => {
      resolve(q, { chain, limit: 8, minLiquidityUsd }).then((r) => {
        if (!r) return;
        // Address or unambiguous single hit → auto-select.
        if (r.kind === 'address' && r.best) {
          select(r.best);
        } else if (r.kind === 'ticker' && r.candidates.length === 1) {
          select(r.candidates[0]);
        } else if (r.kind === 'ticker' && r.candidates.length > 1) {
          setShowList(true);
        } else {
          setShowList(false);
        }
      });
    }, 350);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, chain, minLiquidityUsd]);

  function select(t: ResolvedToken) {
    setSelected(t);
    setShowList(false);
    onResolved(t);
  }

  function clear() {
    setSelected(null);
    setValue('');
    setShowList(false);
    reset();
    onResolved(null);
  }

  if (selected) {
    return (
      <div>
        <label className="label">{label}</label>
        <SelectedChip token={selected} onClear={clear} disabled={disabled} />
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <label className="label">{label}</label>
      <input
        className="input mono"
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
      />

      {loading && (
        <div className="mt-2 text-[12px]" style={{ color: 'var(--text-3)' }}>
          Resolving…
        </div>
      )}

      {!loading && error && (
        <div className="mt-2 text-[12px]" style={{ color: 'var(--bad)' }}>
          {error}
        </div>
      )}

      {!loading && !error && result && result.kind === 'unresolvable' && value.trim() && (
        <div className="mt-2 text-[12px]" style={{ color: 'var(--text-3)' }}>
          Not a recognized address or ticker.
        </div>
      )}

      {!loading && !error && result?.kind === 'ticker' && result.candidates.length === 0 && (
        <div className="mt-2 text-[12px]" style={{ color: 'var(--text-3)' }}>
          No token found for <b>${result.query.toUpperCase()}</b>. Paste the contract address instead.
        </div>
      )}

      {showList && result && result.candidates.length > 1 && (
        <div
          className="mt-2 rounded-[10px] overflow-hidden"
          style={{ border: '1px solid var(--border)', background: 'var(--surface-2)' }}
        >
          <div className="px-3 py-2 text-[10.5px] uppercase tracking-wider" style={{ color: 'var(--text-3)', borderBottom: '1px solid var(--border)' }}>
            {result.candidates.length} tokens match ${result.query.toUpperCase()} — pick one
          </div>
          {result.candidates.map((t) => (
            <button
              key={`${t.chainId}:${t.address}`}
              type="button"
              onClick={() => select(t)}
              className="w-full text-left"
              style={{ background: 'none', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', padding: '10px 12px' }}
            >
              <div className="flex items-center gap-3">
                <TokenLogo token={t} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
                      {t.symbol}
                    </span>
                    {t.verified && <span className="chip chip-ok" style={{ fontSize: 9, padding: '0 5px' }}>✓ listed</span>}
                    <span className="chip" style={{ fontSize: 9, padding: '0 5px' }}>{chainLabel(t.chain)}</span>
                  </div>
                  <div className="text-[11px] truncate" style={{ color: 'var(--text-3)' }}>
                    {t.name} · <span className="mono">{shortAddr(t.address)}</span>
                  </div>
                </div>
                <div className="text-right" style={{ flexShrink: 0 }}>
                  <div className="font-mono text-[11.5px]" style={{ color: 'var(--text-2)' }}>
                    {fmtUsd(t.liquidityUsd)} liq
                  </div>
                  <div className="text-[10.5px]" style={{ color: 'var(--text-3)' }}>
                    {fmtUsd(t.marketCapUsd)} mc · {ageLabel(t.pairAgeHours)}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Selected confirm chip ──────────────────────────────────────────────────── */

function SelectedChip({ token, onClear, disabled }: { token: ResolvedToken; onClear: () => void; disabled?: boolean }) {
  const lowLiq = (token.liquidityUsd ?? 0) < 10_000;
  const risky = lowLiq || !token.verified;
  const tone = lowLiq ? 'var(--bad)' : token.verified ? 'var(--ok)' : 'var(--warn)';
  return (
    <div
      className="rounded-[10px] px-3 py-2.5 flex items-center gap-3"
      style={{ border: `1px solid color-mix(in srgb, ${tone} 40%, var(--border))`, background: `color-mix(in srgb, ${tone} 7%, var(--surface-2))` }}
    >
      <TokenLogo token={token} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold" style={{ color: 'var(--text)' }}>{token.symbol}</span>
          <span className="chip" style={{ fontSize: 9, padding: '0 5px' }}>{chainLabel(token.chain)}</span>
          {token.verified
            ? <span className="chip chip-ok" style={{ fontSize: 9, padding: '0 5px' }}>✓ listed</span>
            : <span className="chip chip-warn" style={{ fontSize: 9, padding: '0 5px' }}>unverified</span>}
        </div>
        <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-3)' }}>
          <span className="mono">{shortAddr(token.address)}</span> · {fmtUsd(token.liquidityUsd)} liq · {fmtUsd(token.marketCapUsd)} mc
        </div>
        {risky && (
          <div className="text-[11px] mt-1" style={{ color: tone }}>
            ⚠ {lowLiq ? 'Low liquidity — confirm this is the right token.' : 'Not listed on CoinGecko — double-check the address.'}
          </div>
        )}
      </div>
      {!disabled && (
        <button
          type="button"
          onClick={onClear}
          className="btn btn-sm btn-ghost"
          style={{ flexShrink: 0 }}
        >
          Change
        </button>
      )}
    </div>
  );
}

function TokenLogo({ token }: { token: ResolvedToken }) {
  const [broken, setBroken] = useState(false);
  if (token.logoURI && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={token.logoURI}
        alt=""
        width={28}
        height={28}
        onError={() => setBroken(true)}
        style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, objectFit: 'cover' }}
      />
    );
  }
  return (
    <span
      className="font-mono"
      style={{
        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--surface)', color: 'var(--text-3)', fontSize: 11, fontWeight: 700,
      }}
    >
      {(token.symbol || '?').slice(0, 2).toUpperCase()}
    </span>
  );
}

/* ── helpers ────────────────────────────────────────────────────────────────── */

function chainLabel(c: Chain): string {
  return c === 'SOLANA' ? 'Solana' : 'EVM';
}
function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function fmtUsd(v: number | null): string {
  if (v == null) return '$0';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}
function ageLabel(hours: number | null): string {
  if (hours == null) return '?';
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h`;
  const d = Math.round(hours / 24);
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

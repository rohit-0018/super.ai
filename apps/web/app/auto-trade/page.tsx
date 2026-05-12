'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import { useApi, invalidate } from '../../lib/useApi';
import { useRealtime } from '../../lib/useRealtime';
import { Skeleton } from '../../components/ui/Skeleton';
import { fmtPriceUsd } from '../../lib/format-price';

/* ── Types (mirror Prisma rows) ────────────────────────────────────────── */
interface Portfolio {
  userId: string;
  startingBalanceUsd: number;
  currentBalanceUsd: number;
  realizedPnlUsd: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  autoEnabled: boolean;
  autoProfile: string;
  autoMinScore: number;
  positionSizeUsd: number;
  maxConcurrent: number;
  cooldownMinutes: number;
}
interface Position {
  id: string;
  tokenAddress: string;
  symbol: string | null;
  name: string | null;
  profileKey: string;
  openedAt: string;
  entryPriceUsd: number;
  sizeUsd: number;
  tokenAmount: number;
  takeProfit1PriceUsd: number;
  takeProfit2PriceUsd: number;
  stopLossPriceUsd: number;
  currentPriceUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  scoreAtEntry: number;
  verdictAtEntry: string;
}
interface Trade {
  id: string;
  tokenAddress: string;
  symbol: string | null;
  profileKey: string;
  openedAt: string;
  closedAt: string;
  holdMs: number;
  entryPriceUsd: number;
  exitPriceUsd: number;
  pnlUsd: number;
  pnlPct: number;
  exitReason: 'TP1' | 'TP2' | 'STOP_LOSS' | 'MAX_HOLD' | 'MANUAL' | 'RUG';
  scoreAtEntry: number;
  verdictAtEntry: string;
}

interface UserMe { id: string; paperMode: boolean }

const PROFILES = ['meme_hunter', 'degen_sniper', 'swing_trader', 'gem_hunt', 'alpha_hunt'];

/* ── Page ──────────────────────────────────────────────────────────────── */
export default function AutoTradePage() {
  const { data: me } = useApi<UserMe>('/auth/me', { ttlMs: 60_000 });
  const { data: portfolio, loading: pLoading } = useApi<Portfolio>('/auto-trade/portfolio', { ttlMs: 10_000 });
  const { data: positions } = useApi<Position[]>('/auto-trade/positions', { pollMs: 8_000 });
  const { data: trades } = useApi<Trade[]>('/auto-trade/trades?take=50', { ttlMs: 10_000 });

  // Local state: optimistic auto-toggle + just-closed tracking for animation
  const [optimisticAuto, setOptimisticAuto] = useState<boolean | null>(null);
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const [highlightTradeIds, setHighlightTradeIds] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Array<{ id: string; symbol: string; pnl: number; reason: string }>>([]);

  const autoOn = optimisticAuto ?? portfolio?.autoEnabled ?? false;
  const isPaperMode = me?.paperMode !== false; // default to paper if unknown

  // Realtime: portfolio + open updates → just invalidate; closed event needs
  // special lifecycle handling so the row animates from Active → Closed.
  useRealtime('auto_portfolio_updated', () => { invalidate('/auto-trade/portfolio'); });
  useRealtime('auto_position_opened',  () => { invalidate('/auto-trade/positions'); });
  useRealtime('auto_position_updated', () => { invalidate('/auto-trade/positions'); });
  useRealtime('auto_position_closed',  (payload: { trade: Trade; wasOpenId: string }) => {
    // Phase 1: mark the open row as "closing" so it animates out (350ms).
    setClosingIds((s) => new Set(s).add(payload.wasOpenId));
    // Phase 2: highlight the new closed row briefly so the user clearly
    // sees where the position went.
    setHighlightTradeIds((s) => new Set(s).add(payload.trade.id));
    setTimeout(() => setHighlightTradeIds((s) => { const n = new Set(s); n.delete(payload.trade.id); return n; }), 4_000);
    // Toast
    const toastId = `${payload.trade.id}-${Date.now()}`;
    setToasts((t) => [
      ...t,
      {
        id: toastId,
        symbol: payload.trade.symbol ?? payload.trade.tokenAddress.slice(0, 6),
        pnl: payload.trade.pnlUsd,
        reason: payload.trade.exitReason,
      },
    ]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== toastId)), 5_000);
    // After the out-animation completes, refetch so the row is actually gone.
    setTimeout(() => {
      invalidate('/auto-trade/positions');
      invalidate('/auto-trade/trades?take=50');
      invalidate('/auto-trade/portfolio');
      setClosingIds((s) => { const n = new Set(s); n.delete(payload.wasOpenId); return n; });
    }, 380);
  });

  const onToggleAuto = useCallback(async () => {
    setOptimisticAuto(!autoOn);
    try {
      if (autoOn) await api.post('/auto-trade/auto/stop', {});
      else        await api.post('/auto-trade/auto/start', {});
      invalidate('/auto-trade/portfolio');
    } catch { setOptimisticAuto(autoOn); }
  }, [autoOn]);

  const onReset = useCallback(async () => {
    if (!confirm('Reset auto-trade portfolio? This wipes positions, trades, and PnL. Auto-mode will be turned off.')) return;
    await api.post('/auto-trade/reset', {});
    invalidate('/auto-trade/portfolio');
    invalidate('/auto-trade/positions');
    invalidate('/auto-trade/trades?take=50');
  }, []);

  if (pLoading || !portfolio) {
    return (
      <div className="page space-y-4">
        <Skeleton h={28} w={220} />
        <Skeleton h={140} rounded="md" />
        <Skeleton h={200} rounded="md" />
      </div>
    );
  }

  const winRate = portfolio.totalTrades > 0
    ? Math.round((portfolio.winCount / portfolio.totalTrades) * 100)
    : null;
  const totalEquity = portfolio.currentBalanceUsd
    + (positions ?? []).reduce((acc, p) => acc + p.sizeUsd + p.unrealizedPnlUsd, 0);
  const totalPnl = totalEquity - portfolio.startingBalanceUsd;

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div className="section-eyebrow">Auto-trading engine</div>
          <h1 className="page-title">🤖 Auto Trade</h1>
          <p className="page-subtitle">
            Picks the strongest hot-scan tokens, opens positions, tracks live price, books PnL on TP/SL hits.
            Same engine — flip mode chip to switch between practice and live money (live disabled in v1).
          </p>
        </div>
        <ModeChip isPaper={isPaperMode} />
      </header>

      {/* ── Stat strip ───────────────────────────────────────────────── */}
      <section style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <StatCard label="Balance"   value={`$${totalEquity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} sub="incl. open positions" />
        <StatCard label="Total P&L" value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)}`} valueColor={totalPnl >= 0 ? 'var(--ok)' : 'var(--bad)'} sub={`from $${portfolio.startingBalanceUsd.toLocaleString()}`} />
        <StatCard label="Realized"  value={`${portfolio.realizedPnlUsd >= 0 ? '+' : ''}$${portfolio.realizedPnlUsd.toFixed(0)}`} valueColor={portfolio.realizedPnlUsd >= 0 ? 'var(--ok)' : 'var(--bad)'} sub={`${portfolio.totalTrades} trades`} />
        <StatCard label="Win rate"  value={winRate != null ? `${winRate}%` : '—'} sub={`${portfolio.winCount}W / ${portfolio.lossCount}L`} />
        <StatCard label="Active"    value={`${positions?.length ?? 0}`} sub={`of ${portfolio.maxConcurrent} max`} />
      </section>

      {/* ── Auto-mode control ────────────────────────────────────────── */}
      <AutoControlPanel portfolio={portfolio} autoOn={autoOn} onToggle={onToggleAuto} onReset={onReset} />

      {/* ── Active positions ─────────────────────────────────────────── */}
      <section className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        <header style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <h2 className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: autoOn ? 'var(--ok)' : 'var(--text-3)' }} className={autoOn ? 'at-live-dot' : ''} />
            Active positions
            <span className="chip" style={{ fontSize: 10, color: 'var(--text-3)' }}>{positions?.length ?? 0}</span>
          </h2>
        </header>
        <PositionsTable positions={positions ?? []} closingIds={closingIds} />
      </section>

      {/* ── Closed positions ─────────────────────────────────────────── */}
      <section className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        <header style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <h2 className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
            📦 Closed positions
            <span className="chip" style={{ fontSize: 10, color: 'var(--text-3)' }}>{trades?.length ?? 0}</span>
            <span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 'auto', fontWeight: 400 }}>
              auto-archived from Active — review what worked / what didn't
            </span>
          </h2>
        </header>
        <TradesTable trades={trades ?? []} highlightIds={highlightTradeIds} />
      </section>

      {/* ── Toasts ───────────────────────────────────────────────────── */}
      <div style={{ position: 'fixed', bottom: 24, right: 24, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 50, pointerEvents: 'none' }}>
        {toasts.map((t) => (
          <div key={t.id} className="at-toast" style={{
            padding: '10px 14px', borderRadius: 8,
            background: t.pnl >= 0 ? 'color-mix(in srgb, var(--ok) 18%, var(--surface))' : 'color-mix(in srgb, var(--bad) 18%, var(--surface))',
            border: `1px solid ${t.pnl >= 0 ? 'var(--ok)' : 'var(--bad)'}`,
            color: 'var(--text-1)', fontSize: 12, fontWeight: 600,
            minWidth: 220, pointerEvents: 'auto',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span>${t.symbol} · <ExitReasonInline reason={t.reason} /></span>
              <span style={{ color: t.pnl >= 0 ? 'var(--ok)' : 'var(--bad)', fontWeight: 800 }}>
                {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}
              </span>
            </div>
          </div>
        ))}
      </div>

      <style jsx global>{`
        @keyframes at-flash-up   { from { background: color-mix(in srgb, var(--ok) 28%, transparent); } to { background: transparent; } }
        @keyframes at-flash-down { from { background: color-mix(in srgb, var(--bad) 28%, transparent); } to { background: transparent; } }
        .at-flash-up   { animation: at-flash-up   600ms ease-out; }
        .at-flash-down { animation: at-flash-down 600ms ease-out; }

        @keyframes at-row-enter {
          0%   { opacity: 0; transform: translateX(-12px); background: color-mix(in srgb, var(--accent) 14%, transparent); }
          70%  { opacity: 1; transform: translateX(0); background: color-mix(in srgb, var(--accent) 6%, transparent); }
          100% { opacity: 1; transform: translateX(0); background: transparent; }
        }
        .at-row-enter { animation: at-row-enter 380ms ease-out; }

        @keyframes at-row-exit {
          0%   { opacity: 1; transform: translateX(0); background: color-mix(in srgb, var(--warn) 8%, transparent); }
          100% { opacity: 0; transform: translateX(24px); background: color-mix(in srgb, var(--warn) 18%, transparent); }
        }
        .at-row-exit { animation: at-row-exit 380ms ease-in forwards; }

        @keyframes at-row-highlight {
          0%, 70% { background: color-mix(in srgb, var(--accent) 10%, transparent); }
          100%    { background: transparent; }
        }
        .at-row-highlight { animation: at-row-highlight 4s ease-out; }

        @keyframes at-toast-slide {
          0%   { opacity: 0; transform: translateY(8px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .at-toast { animation: at-toast-slide 220ms ease-out; }

        @keyframes at-live-pulse {
          0%, 100% { transform: scale(1);   opacity: 1; }
          50%      { transform: scale(0.7); opacity: 0.5; }
        }
        .at-live-dot { animation: at-live-pulse 1.4s ease-in-out infinite; }

        @keyframes at-auto-glow {
          0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 35%, transparent); }
          50%      { box-shadow: 0 0 0 10px transparent; }
        }
        .at-auto-on { animation: at-auto-glow 1.6s ease-in-out infinite; }

        @media (prefers-reduced-motion: reduce) {
          .at-flash-up, .at-flash-down, .at-row-enter, .at-row-exit, .at-row-highlight,
          .at-toast, .at-live-dot, .at-auto-on { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

/* ── Mode chip ─────────────────────────────────────────────────────────── */
function ModeChip({ isPaper }: { isPaper: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {isPaper ? (
        <span style={{
          padding: '6px 12px', borderRadius: 999,
          background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
          border: '1px solid var(--accent)',
          color: 'var(--accent)', fontSize: 11, fontWeight: 800, letterSpacing: '0.08em',
        }}>
          🧪 PAPER MODE · fake money
        </span>
      ) : (
        <span style={{
          padding: '6px 12px', borderRadius: 999,
          background: 'color-mix(in srgb, var(--bad) 20%, transparent)',
          border: '1px solid var(--bad)',
          color: 'var(--bad)', fontSize: 11, fontWeight: 800, letterSpacing: '0.08em',
        }}>
          🔴 LIVE · real money
        </span>
      )}
      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
        {isPaper ? 'No on-chain trades. Switch in /settings.' : 'Trades execute on-chain.'}
      </span>
    </div>
  );
}

/* ── Auto-mode panel ────────────────────────────────────────────────── */
function AutoControlPanel({
  portfolio, autoOn, onToggle, onReset,
}: {
  portfolio: Portfolio;
  autoOn: boolean;
  onToggle: () => void;
  onReset: () => void;
}) {
  const [profile, setProfile] = useState(portfolio.autoProfile);
  const [minScore, setMinScore] = useState(portfolio.autoMinScore);
  const [size, setSize] = useState(portfolio.positionSizeUsd);
  const [maxConcurrent, setMaxConcurrent] = useState(portfolio.maxConcurrent);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setProfile(portfolio.autoProfile);
    setMinScore(portfolio.autoMinScore);
    setSize(portfolio.positionSizeUsd);
    setMaxConcurrent(portfolio.maxConcurrent);
  }, [portfolio]);

  const dirty =
    profile !== portfolio.autoProfile ||
    minScore !== portfolio.autoMinScore ||
    size !== portfolio.positionSizeUsd ||
    maxConcurrent !== portfolio.maxConcurrent;

  const saveSettings = async () => {
    setSaving(true);
    try {
      await api.post('/auto-trade/settings', {
        autoProfile: profile, autoMinScore: minScore, positionSizeUsd: size, maxConcurrent,
      });
      invalidate('/auto-trade/portfolio');
    } finally { setSaving(false); }
  };

  return (
    <section
      className="panel"
      style={{
        padding: 16, display: 'grid', gap: 14,
        gridTemplateColumns: 'minmax(160px, auto) 1fr',
        border: autoOn ? '1px solid var(--ok)' : undefined,
        background: autoOn ? 'color-mix(in srgb, var(--ok) 5%, var(--surface))' : 'var(--surface)',
        transition: 'background 0.3s, border-color 0.3s',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', justifyContent: 'center' }}>
        <button
          onClick={onToggle}
          className={autoOn ? 'at-auto-on' : ''}
          style={{
            padding: '12px 22px',
            background: autoOn ? 'var(--ok)' : 'var(--surface-2)',
            color: autoOn ? '#fff' : 'var(--text-1)',
            border: `1px solid ${autoOn ? 'var(--ok)' : 'var(--border)'}`,
            borderRadius: 999,
            fontWeight: 800,
            fontSize: 14,
            letterSpacing: '0.04em',
            cursor: 'pointer',
            transition: 'background 0.15s',
          }}
        >
          {autoOn ? '⏹  STOP AUTO' : '▶  START AUTO'}
        </button>
        <button
          onClick={onReset}
          style={{
            padding: '6px 12px',
            background: 'transparent',
            color: 'var(--text-3)',
            border: '1px dashed var(--border-2)',
            borderRadius: 6,
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Reset portfolio
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        <Field label="Profile">
          <select value={profile} onChange={(e) => setProfile(e.target.value)}
            style={selectStyle} disabled={autoOn}>
            {PROFILES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label={`Min score (${minScore})`}>
          <input type="range" min={50} max={95} step={1} value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            disabled={autoOn} style={{ width: '100%' }} />
        </Field>
        <Field label="Position size (USD)">
          <input type="number" value={size} min={10} step={10}
            onChange={(e) => setSize(Number(e.target.value))}
            disabled={autoOn} style={inputStyle} />
        </Field>
        <Field label="Max concurrent">
          <input type="number" value={maxConcurrent} min={1} max={50}
            onChange={(e) => setMaxConcurrent(Number(e.target.value))}
            disabled={autoOn} style={inputStyle} />
        </Field>
        <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {autoOn ? 'Pause auto-mode to change settings' : `cooldown ${portfolio.cooldownMinutes}min · profile defaults used for TP/SL`}
          </span>
          {dirty && !autoOn && (
            <button onClick={saveSettings} disabled={saving}
              style={{ ...primaryBtnStyle, fontSize: 12 }}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/* ── Positions table ────────────────────────────────────────────────── */
function PositionsTable({ positions, closingIds }: { positions: Position[]; closingIds: Set<string> }) {
  if (!positions.length) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
        No active positions yet. Flip <strong>START AUTO</strong> above and wait for the next hot-scan tick to fill one.
      </div>
    );
  }
  return (
    // Fixed-height scrollable — real trading terminal vibe. Sticky header
    // means columns stay visible no matter how many positions are open.
    <div style={{ maxHeight: 420, overflow: 'auto' }}>
      <table style={tableStyle}>
        <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--surface)' }}>
          <tr>
            <th style={thStyle}>Token</th>
            <th style={thStyle}>Score</th>
            <th style={thStyle}>Entry</th>
            <th style={thStyle}>Current</th>
            <th style={thStyle}>Unrealized</th>
            <th style={thStyle}>TP1 / TP2 / SL</th>
            <th style={thStyle}>Age</th>
            <th style={thStyle}></th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <PositionRow key={p.id} p={p} isClosing={closingIds.has(p.id)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PositionRow({ p, isClosing }: { p: Position; isClosing: boolean }) {
  const pnlColor = p.unrealizedPnlUsd >= 0 ? 'var(--ok)' : 'var(--bad)';
  const flash = useFlash(p.currentPriceUsd);
  const isNew = useIsNew(p.id);
  const ageMs = Date.now() - new Date(p.openedAt).getTime();
  const ageStr = ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s`
    : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m`
    : `${Math.floor(ageMs / 3_600_000)}h`;
  const className = isClosing ? 'at-row-exit' : isNew ? 'at-row-enter' : '';
  return (
    <tr style={{ borderTop: '1px solid var(--border)' }} className={className}>
      <td style={tdStyle}>
        <Link href={`/intel?address=${p.tokenAddress}`} style={{ color: 'var(--text-1)', fontWeight: 700, textDecoration: 'none' }}>
          ${p.symbol ?? p.tokenAddress.slice(0, 6)}
        </Link>
        <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{p.profileKey}</div>
      </td>
      <td style={tdStyle}>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{p.scoreAtEntry}</span>
        <div style={{ fontSize: 9, color: 'var(--text-3)' }}>{p.verdictAtEntry}</div>
      </td>
      <td style={tdStyle}>{fmtPriceUsd(p.entryPriceUsd)}</td>
      <td style={tdStyle} className={flash ? `at-flash-${flash}` : ''}>
        {fmtPriceUsd(p.currentPriceUsd)}
      </td>
      <td style={{ ...tdStyle, color: pnlColor, fontWeight: 700 }}>
        {p.unrealizedPnlUsd >= 0 ? '+' : ''}${p.unrealizedPnlUsd.toFixed(2)}
        <div style={{ fontSize: 10, fontWeight: 500 }}>
          {p.unrealizedPnlPct >= 0 ? '+' : ''}{p.unrealizedPnlPct.toFixed(1)}%
        </div>
      </td>
      <td style={{ ...tdStyle, fontSize: 10, fontFamily: 'var(--font-mono)' }}>
        <span style={{ color: 'var(--ok)' }}>{fmtPriceUsd(p.takeProfit1PriceUsd)}</span>
        {' / '}
        <span style={{ color: 'var(--ok)' }}>{fmtPriceUsd(p.takeProfit2PriceUsd)}</span>
        <div style={{ color: 'var(--bad)' }}>SL {fmtPriceUsd(p.stopLossPriceUsd)}</div>
      </td>
      <td style={tdStyle}>{ageStr}</td>
      <td style={tdStyle}>
        <DexLink address={p.tokenAddress} />
      </td>
      <td style={tdStyle}>
        <button onClick={() => closePosition(p.id, p.currentPriceUsd)}
          disabled={isClosing}
          style={{ padding: '4px 10px', fontSize: 11, background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 5, cursor: isClosing ? 'wait' : 'pointer', opacity: isClosing ? 0.5 : 1 }}>
          Close
        </button>
      </td>
    </tr>
  );
}

function DexLink({ address }: { address: string }) {
  return (
    <a
      href={`https://dexscreener.com/solana/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      title="Open DexScreener chart"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        padding: '2px 6px', borderRadius: 4,
        background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--accent) 28%, var(--border))',
        color: 'var(--accent)', fontSize: 10, fontWeight: 700, textDecoration: 'none',
      }}
    >📈 Dex</a>
  );
}

async function closePosition(id: string, currentPrice: number) {
  await api.post(`/auto-trade/positions/${id}/close`, { exitPriceUsd: currentPrice });
  // No invalidate here — the WS event will trigger the close lifecycle.
}

/* ── Trades table ───────────────────────────────────────────────────── */
function TradesTable({ trades, highlightIds }: { trades: Trade[]; highlightIds: Set<string> }) {
  if (!trades.length) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
        No closed trades yet — they'll appear here as positions hit TP1/TP2/SL or you close them manually.
      </div>
    );
  }
  return (
    <div style={{ maxHeight: 420, overflow: 'auto' }}>
      <table style={tableStyle}>
        <thead style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--surface)' }}>
          <tr>
            <th style={thStyle}>Token</th>
            <th style={thStyle}>Score</th>
            <th style={thStyle}>Entry → Exit</th>
            <th style={thStyle}>P&L</th>
            <th style={thStyle}>Reason</th>
            <th style={thStyle}>Held</th>
            <th style={thStyle}>Closed</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const pnlColor = t.pnlUsd >= 0 ? 'var(--ok)' : 'var(--bad)';
            const highlighted = highlightIds.has(t.id);
            return (
              <tr key={t.id} style={{ borderTop: '1px solid var(--border)' }} className={highlighted ? 'at-row-highlight' : ''}>
                <td style={tdStyle}>
                  <Link href={`/intel?address=${t.tokenAddress}`} style={{ color: 'var(--text-1)', fontWeight: 700, textDecoration: 'none' }}>
                    ${t.symbol ?? t.tokenAddress.slice(0, 6)}
                  </Link>
                </td>
                <td style={tdStyle}>{t.scoreAtEntry}</td>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {fmtPriceUsd(t.entryPriceUsd)} → {fmtPriceUsd(t.exitPriceUsd)}
                </td>
                <td style={{ ...tdStyle, color: pnlColor, fontWeight: 700 }}>
                  {t.pnlUsd >= 0 ? '+' : ''}${t.pnlUsd.toFixed(2)}
                  <div style={{ fontSize: 10, fontWeight: 500 }}>
                    {t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(1)}%
                  </div>
                </td>
                <td style={{ ...tdStyle, fontSize: 11 }}>
                  <ExitChip reason={t.exitReason} />
                </td>
                <td style={tdStyle}>
                  {t.holdMs < 60_000 ? `${Math.floor(t.holdMs / 1000)}s`
                    : t.holdMs < 3_600_000 ? `${Math.floor(t.holdMs / 60_000)}m`
                    : `${Math.floor(t.holdMs / 3_600_000)}h`}
                </td>
                <td style={{ ...tdStyle, fontSize: 11, color: 'var(--text-3)' }}>
                  {relTime(t.closedAt)}
                </td>
                <td style={tdStyle}>
                  <DexLink address={t.tokenAddress} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ExitChip({ reason }: { reason: Trade['exitReason'] }) {
  const meta = exitMeta(reason);
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 4,
      background: `color-mix(in srgb, ${meta.color} 18%, transparent)`,
      color: meta.color,
      fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
    }}>{meta.label}</span>
  );
}

function ExitReasonInline({ reason }: { reason: string }) {
  const meta = exitMeta(reason as Trade['exitReason']);
  return <span style={{ color: meta.color, fontWeight: 800 }}>{meta.label}</span>;
}

function exitMeta(reason: Trade['exitReason']) {
  return {
    TP1:       { label: 'TP1',      color: '#4ade80' },
    TP2:       { label: 'TP2',      color: '#22c55e' },
    STOP_LOSS: { label: 'SL',       color: '#ef4444' },
    MAX_HOLD:  { label: 'time-out', color: '#f59e0b' },
    MANUAL:    { label: 'manual',   color: '#8a8fa3' },
    RUG:       { label: 'rug',      color: '#7f1d1d' },
  }[reason];
}

/* ── Helpers ────────────────────────────────────────────────────────── */
function StatCard({ label, value, sub, valueColor }: { label: string; value: string; sub?: string; valueColor?: string }) {
  return (
    <div className="panel" style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4, color: valueColor ?? 'var(--text-1)', fontFamily: 'var(--font-mono)' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
      {children}
    </label>
  );
}

function useFlash(value: number): 'up' | 'down' | null {
  const prev = useRef<number | undefined>(undefined);
  const [state, setState] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (prev.current === undefined) { prev.current = value; return; }
    if (Math.abs(value - prev.current) < 1e-9) return;
    const dir = value > prev.current ? 'up' : 'down';
    prev.current = value;
    setState(dir);
    const id = setTimeout(() => setState(null), 600);
    return () => clearTimeout(id);
  }, [value]);
  return state;
}

/** True only for the first ~400ms after a row first appears in the list,
 *  so the slide-in animation fires once and then stops. */
function useIsNew(id: string): boolean {
  const [isNew, setIsNew] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setIsNew(false), 420);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return isNew;
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 12 };
const thStyle: React.CSSProperties = {
  padding: '8px 12px', textAlign: 'left',
  fontSize: 10, fontWeight: 700, color: 'var(--text-3)',
  textTransform: 'uppercase', letterSpacing: '0.08em',
  borderBottom: '1px solid var(--border)',
};
const tdStyle: React.CSSProperties = { padding: '10px 12px', verticalAlign: 'middle' };
const selectStyle: React.CSSProperties = {
  background: 'var(--surface-2)', color: 'var(--text-1)',
  border: '1px solid var(--border)', borderRadius: 5, padding: '5px 8px', fontSize: 12,
};
const inputStyle: React.CSSProperties = { ...selectStyle, width: '100%' };
const primaryBtnStyle: React.CSSProperties = {
  background: 'var(--accent)', color: '#fff', border: 'none',
  borderRadius: 5, padding: '6px 14px', fontWeight: 700, cursor: 'pointer',
};

'use client';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';

/* ── Virtual scroll row heights (px) ── */
const GROUP_ROW_H = 56;
const MSG_ROW_H   = 50;

/* ── useVirtual: fixed-height windowed list engine ── */
function useVirtual(count: number, rowH: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [st, setSt] = useState(0);
  const [ch, setCh] = useState(500);

  useEffect(() => {
    const el = ref.current; if (!el) return;
    setCh(el.clientHeight);
    const ro = new ResizeObserver(() => setCh(el.clientHeight));
    ro.observe(el); return () => ro.disconnect();
  }, []);

  const OV    = 4;
  const start = Math.max(0, Math.floor(st / rowH) - OV);
  const end   = Math.min(count, Math.ceil((st + ch) / rowH) + OV);
  const total = count * rowH;
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => setSt(e.currentTarget.scrollTop);

  return { ref, start, end, total, onScroll, scrollTop: st };
}
import QRCode from 'react-qr-code';
import { useApi, invalidate, mutate } from '../../lib/useApi';
import { useRealtime } from '../../lib/useRealtime';
import { api } from '../../lib/api';
import { Skeleton, Spinner } from '../../components/ui/Skeleton';

type ColKey = 'setup' | 'inbox' | 'history';

/* ─────────────────────────────────────────────────────────────
   Types
───────────────────────────────────────────────────────────── */
interface SnipeConfig {
  enabled: boolean;
  chain: 'SOLANA' | 'EVM';
  walletId: string;
  buyAmountRaw: string;
  maxSlippageBps: number;
  groupIds: string[];
  skipSafety: boolean;
  dedupeWindowMs: number;
  notifyOnBuy: boolean;
  matchPattern: string | null;
  sellEnabled: boolean;
  sellMode: 'TRIGGER' | 'INTELLIGENT';
  takeProfitPct: number | null;
  stopLossPct: number | null;
  trailingStopPct: number | null;
  exitAfterMs: number | null;
  partialExitPct: number | null;
}

interface GroupOverride {
  id?: string;
  groupId: string;
  groupTitle: string;
  enabled: boolean;
  buyAmountRaw?: string | null;
  maxSlippageBps?: number | null;
  sellMode?: 'TRIGGER' | 'INTELLIGENT' | null;
  takeProfitPct?: number | null;
  stopLossPct?: number | null;
  trailingStopPct?: number | null;
  exitAfterMs?: number | null;
  matchPattern?: string | null;
}

interface TgStatus {
  connected: boolean;
  qrPending?: boolean;
  me: { phone: string; username: string | null; firstName: string } | null;
}

interface TgGroup {
  id: string;
  title: string;
  isChannel: boolean;
  members: number | null;
  lastMessage: { text: string; ts: number } | null;
}

interface TgMessage {
  id: number;
  text: string;
  ts: number;
  fromId: string;
  senderName?: string;
}

interface SnipeTrade {
  id: string;
  mint: string;
  amountRaw: string;
  txHash: string | null;
  outAmount: string | null;
  status: string;
  errorMsg: string | null;
  sourceMsg: string | null;
  groupId: string;
  chain: string;
  sellStatus: string | null;
  sellTxHash: string | null;
  sellReason: string | null;
  attempts: number;
  createdAt: string;
}

interface Wallet { id: string; chain: string; address: string; label: string | null }

/* ─────────────────────────────────────────────────────────────
   Page
───────────────────────────────────────────────────────────── */
interface SnipeBannerData {
  status: string;
  mint: string;
  durationMs: number;
  txHash: string | null;
  error?: string;
  key: number; // force re-mount to restart animation
}

export default function SnipePage() {
  const { data: configData, loading: configLoading } = useApi<{ config: SnipeConfig | null; session: { active: boolean; address?: string; balanceLamports?: number } }>('/snipe/config');
  const { data: tgRaw,    loading: tgLoading }        = useApi<TgStatus>('/snipe/tg/status');
  const { data: history, loading: histLoading }       = useApi<SnipeTrade[]>('/snipe/history?limit=50');
  const { data: wallets }                             = useApi<Wallet[]>('/wallets');

  const [tgStatus, setTgStatus] = useState<TgStatus | null>(null);
  useEffect(() => { if (tgRaw !== undefined) setTgStatus(tgRaw ?? null); }, [tgRaw]);
  useRealtime('tg_status', useCallback((evt: TgStatus) => {
    setTgStatus(evt);
    invalidate('/snipe/tg/status');
  }, []));

  const [banner, setBanner]         = useState<SnipeBannerData | null>(null);
  const [sellBanner, setSellBanner] = useState<SnipeBannerData | null>(null);
  const [startAnim, setStartAnim]       = useState(0); // yellow — buy broadcast
  const [completeAnim, setCompleteAnim] = useState(0); // green  — buy confirmed
  const [sellAnim, setSellAnim]         = useState(0); // orange — sell broadcast
  const [soldAnim, setSoldAnim]         = useState(0); // purple — sell confirmed
  const [killing, setKilling]     = useState(false);
  const sellBannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'setup' | 'inbox' | 'trades'>('inbox');
  const [expandedCol, setExpandedCol] = useState<ColKey | null>(null);
  const bannerKeyRef  = useRef(0);
  const bannerTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoStarted   = useRef(false);

  // ── Auto-start session silently on page load ─────────────────────────
  useEffect(() => {
    if (autoStarted.current) return;
    if (!configData) return;
    const cfg = configData.config;
    if (!cfg?.walletId) return;
    if (configData.session.active) { autoStarted.current = true; return; }
    autoStarted.current = true;
    // Fire-and-forget — if it fails (no KMS key, etc.) the user still sees the UI
    api.post('/snipe/session/start', { walletId: cfg.walletId })
      .then(() => invalidate('/snipe/config'))
      .catch(() => {}); // silent — they can still use the page
  }, [configData]);

  useRealtime('snipe_triggered', useCallback((evt: any) => {
    invalidate('/snipe/history?limit=50');
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    bannerKeyRef.current += 1;
    setBanner({ status: evt.status, mint: evt.mint, durationMs: evt.durationMs, txHash: evt.txHash, error: evt.error, key: bannerKeyRef.current });
    bannerTimer.current = setTimeout(() => setBanner(null), 3300);
    // Yellow burst when shot is fired (broadcast), regardless of outcome
    if (evt.status !== 'failed') setStartAnim((n) => n + 1);
  }, []));

  useRealtime('snipe_update', useCallback((evt: any) => {
    invalidate('/snipe/history?limit=50');
    // Green burst when tx lands on-chain
    if (evt.status === 'confirmed') setCompleteAnim((n) => n + 1);
  }, []));

  useRealtime('snipe_sold', useCallback((evt: any) => {
    invalidate('/snipe/history?limit=50');
    setSellAnim((n) => n + 1);
    if (sellBannerTimer.current) clearTimeout(sellBannerTimer.current);
    bannerKeyRef.current += 1;
    setSellBanner({
      status: evt.sellStatus ?? 'broadcast',
      mint: evt.mint ?? '',
      durationMs: evt.durationMs ?? 0,
      txHash: evt.txHash ?? null,
      key: bannerKeyRef.current,
    });
    sellBannerTimer.current = setTimeout(() => setSellBanner(null), 3300);
  }, []));

  useRealtime('snipe_sold_confirmed', useCallback((evt: any) => {
    invalidate('/snipe/history?limit=50');
    setSoldAnim((n) => n + 1);
    if (sellBannerTimer.current) clearTimeout(sellBannerTimer.current);
    bannerKeyRef.current += 1;
    setSellBanner({
      status: 'confirmed',
      mint: evt.mint ?? '',
      durationMs: evt.durationMs ?? 0,
      txHash: evt.txHash ?? null,
      key: bannerKeyRef.current,
    });
    sellBannerTimer.current = setTimeout(() => setSellBanner(null), 3300);
  }, []));

  useRealtime('snipe_sell_update', useCallback((evt: any) => {
    invalidate('/snipe/history?limit=50');
    if (evt.sellStatus === 'failed') {
      if (sellBannerTimer.current) clearTimeout(sellBannerTimer.current);
      bannerKeyRef.current += 1;
      setSellBanner({
        status: 'failed',
        mint: evt.mint ?? '',
        durationMs: 0,
        txHash: evt.txHash ?? null,
        error: evt.error,
        key: bannerKeyRef.current,
      });
      sellBannerTimer.current = setTimeout(() => setSellBanner(null), 4000);
    }
  }, []));

  useRealtime('snipe_update', useCallback(() => {
    invalidate('/snipe/history?limit=50');
  }, []));

  const killSession = useCallback(async () => {
    setKilling(true);
    try {
      await api.delete('/snipe/session');
      // Also disable snipe so it doesn't auto-restart next load
      const cfg = configData?.config;
      if (cfg) await api.put('/snipe/config', { ...toSnipeDtoSafe(cfg), enabled: false });
      autoStarted.current = false; // allow re-start if user re-enables
      invalidate('/snipe/config');
    } catch { /* swallow */ } finally { setKilling(false); }
  }, [configData]);

  const config  = configData?.config ?? null;
  const session = configData?.session ?? { active: false };
  const isLive  = !!(session.active && config?.enabled && tgStatus?.connected);

  if (configLoading || tgLoading) return <PageSkeleton />;

  const isColVisible = (k: ColKey) => !expandedCol || expandedCol === k;
  const mkExpandBtn = (k: ColKey) => (
    <button
      className="snipe-expand-btn"
      title={expandedCol === k ? 'Restore' : 'Expand'}
      onClick={() => setExpandedCol(expandedCol === k ? null : k)}
    >
      {expandedCol === k ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/>
        </svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
        </svg>
      )}
    </button>
  );

  return (
    <div className="page page-wide snipe-terminal" style={{ paddingTop: 10 }}>
      {startAnim > 0    && <SnipeFireAnimation key={`s${startAnim}`}    variant="start" />}
      {completeAnim > 0 && <SnipeFireAnimation key={`c${completeAnim}`} variant="complete" />}
      {sellAnim > 0     && <SnipeFireAnimation key={`sv${sellAnim}`}    variant="sell" />}
      {soldAnim > 0     && <SnipeFireAnimation key={`sd${soldAnim}`}    variant="sold" />}
      {banner     && <SnipeBanner key={banner.key}     banner={banner}     onDismiss={() => setBanner(null)} />}
      {sellBanner && <SellBanner  key={sellBanner.key} banner={sellBanner} onDismiss={() => setSellBanner(null)} />}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <IcoSnipe size={14} />
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.02em' }}>Sniper</span>
          <span style={{
            fontSize: 9, fontFamily: 'var(--font-mono)',
            color: 'var(--text-3)', padding: '1px 5px', borderRadius: 3,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
          }}>SOL / CA</span>
        </div>
        <div style={{ flex: 1 }} />
        <StatusBar tg={tgStatus} session={session} config={config} onKill={killSession} killing={killing} />
      </div>

      {/* Kill bar or status notice */}
      <div style={{ marginBottom: 8 }}>
        {isLive
          ? <KillBar onKill={killSession} killing={killing} groups={config?.groupIds.length ?? 0} />
          : <SnipeStatusNotice config={config} tgConnected={!!tgStatus?.connected} />
        }
      </div>

      {/* Mobile panel switcher */}
      <div className="snipe-mobile-tabs">
        {([
          { key: 'setup',  label: 'Setup',  badge: null },
          { key: 'inbox',  label: 'Inbox',  badge: tgStatus?.connected ? null : '!' },
          { key: 'trades', label: 'Trades', badge: history?.length ? String(history.length) : null },
        ] as const).map(({ key, label, badge }) => (
          <button key={key} className={`snipe-mobile-tab${mobilePanel === key ? ' active' : ''}`} onClick={() => setMobilePanel(key)}>
            <span className="font-mono text-[11px] font-semibold">{label}</span>
            {badge && (
              <span style={{
                minWidth: 14, height: 14, borderRadius: 999, padding: '0 3px',
                background: badge === '!' ? 'var(--warn)' : 'var(--accent)',
                color: '#fff', fontSize: 8, fontWeight: 700,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginLeft: 3,
              }}>{badge}</span>
            )}
          </button>
        ))}
      </div>

      <div
        className="snipe-3col"
        data-panel={mobilePanel}
        style={expandedCol ? { gridTemplateColumns: '1fr', gridTemplateAreas: '"active"' } : undefined}
      >
        {/* Col 1: setup */}
        <div className="snipe-col-setup" style={!isColVisible('setup') ? { display: 'none' } : expandedCol === 'setup' ? { gridArea: 'active', width: '100%' } : undefined}>
          <TgPanel status={tgStatus} headerRight={mkExpandBtn('setup')} />
          <ConfigPanel config={config} wallets={wallets ?? []} />
        </div>
        {/* Col 2: inbox */}
        <div className="snipe-col-inbox" style={!isColVisible('inbox') ? { display: 'none' } : expandedCol === 'inbox' ? { gridArea: 'active', width: '100%' } : undefined}>
          <TgInboxPanel config={config} tgConnected={!!tgStatus?.connected} session={session as any} headerRight={mkExpandBtn('inbox')} />
        </div>
        {/* Col 3: history */}
        <div className="snipe-col-history" style={!isColVisible('history') ? { display: 'none' } : expandedCol === 'history' ? { gridArea: 'active', width: '100%' } : undefined}>
          <HistoryPanel trades={history ?? []} loading={histLoading} headerRight={mkExpandBtn('history')} />
        </div>
      </div>
    </div>
  );
}

/** Strip Prisma-only fields — used inside page component too */
function toSnipeDtoSafe(c: SnipeConfig) {
  return {
    enabled: c.enabled, chain: c.chain, walletId: c.walletId,
    buyAmountRaw: c.buyAmountRaw, maxSlippageBps: c.maxSlippageBps,
    groupIds: c.groupIds, skipSafety: c.skipSafety, dedupeWindowMs: c.dedupeWindowMs,
    notifyOnBuy: c.notifyOnBuy, matchPattern: c.matchPattern,
    sellEnabled: c.sellEnabled, sellMode: c.sellMode,
    takeProfitPct: c.takeProfitPct, stopLossPct: c.stopLossPct,
    trailingStopPct: c.trailingStopPct, exitAfterMs: c.exitAfterMs,
    partialExitPct: c.partialExitPct ?? null,
  };
}

/* ─────────────────────────────────────────────────────────────
   Snipe toast — fixed bottom-right, dramatic entrance
───────────────────────────────────────────────────────────── */
function SnipeBanner({ banner, onDismiss }: { banner: SnipeBannerData; onDismiss: () => void }) {
  const ok     = banner.status !== 'failed';
  const accent = ok ? '#f59e0b' : '#ef4444';
  const DURATION = 3800;

  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'fixed', bottom: 28, right: 28, zIndex: 1500,
        width: 320, cursor: 'pointer', borderRadius: 14, overflow: 'hidden',
        background: 'color-mix(in srgb, var(--surface-2) 96%, transparent)',
        border: `1px solid color-mix(in srgb, ${accent} 45%, transparent)`,
        boxShadow: `0 0 0 1px color-mix(in srgb, ${accent} 15%, transparent), 0 8px 40px rgba(0,0,0,0.55), 0 0 60px color-mix(in srgb, ${accent} 8%, transparent)`,
        animation: 'snipe-toast-enter 280ms cubic-bezier(0.22,1,0.36,1) forwards',
      }}
    >
      {/* Scan line sweep */}
      <div style={{
        position: 'absolute', left: 0, right: 0, height: 60, pointerEvents: 'none', zIndex: 0,
        background: `linear-gradient(180deg, transparent 0%, color-mix(in srgb, ${accent} 12%, transparent) 50%, transparent 100%)`,
        animation: 'snipe-toast-scan 1.4s ease-in-out infinite',
      }} />

      {/* Body */}
      <div style={{ position: 'relative', zIndex: 1, padding: '16px 18px 14px' }}>
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 24, lineHeight: 1, filter: `drop-shadow(0 0 10px ${accent})` }}>
            {ok ? '⚡' : '✗'}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '0.07em', color: accent, lineHeight: 1 }}>
              {ok ? 'SNIPED' : 'FAILED'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.1em', marginTop: 3 }}>
              {ok ? 'buy broadcast' : 'trade rejected'}
            </div>
          </div>
          {/* Latency badge */}
          <div style={{
            padding: '5px 11px', borderRadius: 8,
            background: `color-mix(in srgb, ${accent} 15%, transparent)`,
            border: `1px solid color-mix(in srgb, ${accent} 35%, transparent)`,
            textAlign: 'center',
          }}>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color: accent, lineHeight: 1 }}>
              {banner.durationMs}
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-3)', letterSpacing: '0.08em', marginTop: 1 }}>ms</div>
          </div>
        </div>

        {/* Token address */}
        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)', marginBottom: 10,
          background: 'color-mix(in srgb, var(--surface) 70%, transparent)',
          borderRadius: 6, padding: '5px 9px',
          border: '1px solid var(--border)',
          letterSpacing: '0.04em',
        }}>
          {banner.mint.slice(0, 12)}…{banner.mint.slice(-8)}
        </div>

        {banner.error && (
          <div style={{ fontSize: 10, color: accent, marginBottom: 10, lineHeight: 1.4, opacity: 0.85 }}>
            {banner.error.slice(0, 90)}
          </div>
        )}

        {banner.txHash && (
          <a
            href={`https://solscan.io/tx/${banner.txHash}`}
            target="_blank" rel="noopener"
            onClick={(e) => e.stopPropagation()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 10, color: accent, fontFamily: 'var(--font-mono)',
              padding: '4px 9px', borderRadius: 5, textDecoration: 'none',
              background: `color-mix(in srgb, ${accent} 10%, transparent)`,
              border: `1px solid color-mix(in srgb, ${accent} 25%, transparent)`,
            }}
          >
            {banner.txHash.slice(0, 8)}…{banner.txHash.slice(-6)}
            <span style={{ fontSize: 9, opacity: 0.7 }}>↗</span>
          </a>
        )}
      </div>

      {/* Progress countdown bar */}
      <div style={{ height: 2, background: `color-mix(in srgb, ${accent} 18%, transparent)` }}>
        <div style={{
          height: '100%', background: accent, transformOrigin: 'left',
          animation: `snipe-toast-progress ${DURATION}ms linear forwards`,
        }} />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Sell banner — bottom-left to avoid clashing with buy banner
───────────────────────────────────────────────────────────── */
function SellBanner({ banner, onDismiss }: { banner: SnipeBannerData; onDismiss: () => void }) {
  const isConfirmed = banner.status === 'confirmed';
  const isFailed    = banner.status === 'failed';
  const accent      = isConfirmed ? '#a855f7' : isFailed ? '#ef4444' : '#f97316';
  const DURATION    = 3800;

  const label    = isConfirmed ? 'SOLD' : isFailed ? 'SELL FAILED' : 'SELLING';
  const sublabel = isConfirmed ? 'exit confirmed' : isFailed ? 'tx rejected' : 'sell broadcast';
  const icon     = isConfirmed ? '✓' : isFailed ? '✗' : '↓';

  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'fixed', bottom: 28, left: 28, zIndex: 1500,
        width: 300, cursor: 'pointer', borderRadius: 14, overflow: 'hidden',
        background: 'color-mix(in srgb, var(--surface-2) 96%, transparent)',
        border: `1px solid color-mix(in srgb, ${accent} 45%, transparent)`,
        boxShadow: `0 0 0 1px color-mix(in srgb, ${accent} 15%, transparent), 0 8px 40px rgba(0,0,0,0.55), 0 0 60px color-mix(in srgb, ${accent} 8%, transparent)`,
        animation: 'snipe-toast-enter 280ms cubic-bezier(0.22,1,0.36,1) forwards',
      }}
    >
      <div style={{
        position: 'absolute', left: 0, right: 0, height: 60, pointerEvents: 'none', zIndex: 0,
        background: `linear-gradient(180deg, transparent 0%, color-mix(in srgb, ${accent} 12%, transparent) 50%, transparent 100%)`,
        animation: 'snipe-toast-scan 1.4s ease-in-out infinite',
      }} />
      <div style={{ position: 'relative', zIndex: 1, padding: '14px 16px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 22, lineHeight: 1, filter: `drop-shadow(0 0 10px ${accent})`, color: accent }}>
            {icon}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '0.07em', color: accent, lineHeight: 1 }}>
              {label}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.1em', marginTop: 3 }}>
              {sublabel}
            </div>
          </div>
        </div>
        {banner.mint && (
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-2)',
            background: 'color-mix(in srgb, var(--surface) 70%, transparent)',
            borderRadius: 6, padding: '4px 8px', border: '1px solid var(--border)',
            marginBottom: banner.txHash ? 7 : 0,
          }}>
            {banner.mint.slice(0, 12)}…{banner.mint.slice(-8)}
          </div>
        )}
        {banner.error && (
          <div style={{ fontSize: 10, color: accent, marginTop: 6, lineHeight: 1.4, opacity: 0.85 }}>
            {banner.error.slice(0, 80)}
          </div>
        )}
        {banner.txHash && (
          <a
            href={`https://solscan.io/tx/${banner.txHash}`}
            target="_blank" rel="noopener"
            onClick={(e) => e.stopPropagation()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 5,
              fontSize: 10, fontFamily: 'var(--font-mono)', color: accent,
              textDecoration: 'none',
            }}
          >
            {banner.txHash.slice(0, 8)}…{banner.txHash.slice(-6)} ↗
          </a>
        )}
      </div>
      {!isFailed && (
        <div style={{ height: 2, background: `color-mix(in srgb, ${accent} 18%, transparent)` }}>
          <div style={{
            height: '100%', background: accent, transformOrigin: 'left',
            animation: `snipe-toast-progress ${DURATION}ms linear forwards`,
          }} />
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Snipe fire animations
   variant="start"    → yellow burst  (buy broadcast)
   variant="complete" → green burst   (buy confirmed on-chain)
   variant="sell"     → orange burst  (sell broadcast)
   variant="sold"     → purple burst  (sell confirmed on-chain)
   Mounts fresh on each event — key prop forces remount.
───────────────────────────────────────────────────────────── */
function SnipeFireAnimation({ variant }: { variant: 'start' | 'complete' | 'sell' | 'sold' }) {
  const isComplete = variant === 'complete';
  const isSell     = variant === 'sell';
  const isSold     = variant === 'sold';

  const color = isComplete ? '#22c55e'
    : isSell   ? '#f97316'
    : isSold   ? '#a855f7'
    : '#fbbf24';
  const rgba = isComplete ? 'rgba(34,197,94,'
    : isSell   ? 'rgba(249,115,22,'
    : isSold   ? 'rgba(168,85,247,'
    : 'rgba(251,191,36,';
  const RAYS    = (isComplete || isSold) ? 12 : 8;
  const RAY_LEN = (isComplete || isSold) ? 200 : 160;

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        pointerEvents: 'none', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {/* Screen tint */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(ellipse at 50% 40%, ${rgba}0.18) 0%, transparent 70%)`,
        animation: 'snipe-tint 700ms ease-out forwards',
      }} />

      {/* Primary expanding ring */}
      <div style={{
        position: 'absolute',
        width: 80, height: 80, borderRadius: '50%',
        border: `2px solid ${rgba}0.8)`,
        animation: 'snipe-ring 700ms ease-out forwards',
      }} />

      {/* Second ring (complete/sold only — staggered for impact) */}
      {(isComplete || isSold) && (
        <div style={{
          position: 'absolute',
          width: 80, height: 80, borderRadius: '50%',
          border: `1.5px solid ${rgba}0.5)`,
          animation: 'snipe-ring 900ms ease-out forwards',
          animationDelay: '120ms',
        }} />
      )}

      {/* Rays */}
      {Array.from({ length: RAYS }).map((_, i) => (
        <div key={i} style={{
          position: 'absolute',
          width: RAY_LEN, height: isComplete ? 1.5 : 2,
          left: '50%', top: '50%',
          transformOrigin: 'left center',
          '--ray-rotate': `translateY(-50%) rotate(${i * (360 / RAYS)}deg)`,
          transform: `var(--ray-rotate)`,
          background: `linear-gradient(90deg, ${rgba}0.95) 0%, ${rgba}0) 100%)`,
          animation: `snipe-ray ${isComplete ? 800 : 650}ms ease-out forwards`,
          animationDelay: `${i * (isComplete ? 8 : 10)}ms`,
        } as React.CSSProperties} />
      ))}

      {/* Central icon */}
      <div style={{
        position: 'relative', zIndex: 1,
        fontSize: (isComplete || isSold) ? 48 : 42, lineHeight: 1,
        color: color,
        filter: `drop-shadow(0 0 ${(isComplete || isSold) ? 16 : 12}px ${rgba}0.95))`,
        animation: `${(isComplete || isSold) ? 'snipe-check' : 'snipe-bolt'} 750ms ease-out forwards`,
      }}>
        {isSold ? '✓' : isComplete ? '✓' : isSell ? '↓' : '⚡'}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Kill bar — replaces status notice when sniper is fully live
───────────────────────────────────────────────────────────── */
function KillBar({ onKill, killing, groups }: { onKill: () => void; killing: boolean; groups: number }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 16px', borderRadius: 10,
        background: 'color-mix(in srgb, #ef4444 12%, var(--surface))',
        border: '1px solid color-mix(in srgb, #ef4444 40%, transparent)',
        animation: 'kill-bar-appear 220ms ease-out',
      }}
    >
      {/* Live pulse dot */}
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: '#ef4444', flexShrink: 0,
        boxShadow: '0 0 0 0 rgba(239,68,68,0.6)',
        animation: 'kill-pulse 1.4s ease-in-out infinite',
      }} />

      <span className="text-[13px] font-semibold flex-1" style={{ color: '#ef4444', letterSpacing: '0.04em' }}>
        SNIPING LIVE
      </span>

      <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>
        {groups} group{groups !== 1 ? 's' : ''} monitored
      </span>

      <button
        onClick={onKill}
        disabled={killing}
        style={{
          height: 32, padding: '0 16px', borderRadius: 7,
          background: '#ef4444',
          border: '1px solid color-mix(in srgb, #ef4444 75%, black 15%)',
          color: '#fff', fontSize: 12, fontWeight: 700,
          cursor: killing ? 'not-allowed' : 'pointer',
          letterSpacing: '0.06em',
          animation: killing ? 'none' : 'kill-pulse 1.4s ease-in-out infinite',
          opacity: killing ? 0.6 : 1,
          transition: 'opacity 0.15s',
        }}
      >
        {killing ? 'Killing…' : '■ KILL SNIPING'}
      </button>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Setup / activation notice
───────────────────────────────────────────────────────────── */
function SnipeStatusNotice({ config, tgConnected }: { config: SnipeConfig | null; tgConnected: boolean }) {
  const mkStyle = (accent: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '7px 12px', borderRadius: 8, fontSize: 11,
    border: `1px solid color-mix(in srgb, ${accent} 25%, transparent)`,
    background: `color-mix(in srgb, ${accent} 8%, var(--surface))`,
    color: accent,
  });

  if (!config) return (
    <div style={mkStyle('var(--accent)')}>
      <span style={{ flexShrink: 0 }}>⚡</span>
      <span><strong>Not set up.</strong> Pick a wallet, connect Telegram, track groups, flip toggle ON.</span>
    </div>
  );

  if (!config.enabled) return (
    <div style={mkStyle('var(--warn)')}>
      <span style={{ flexShrink: 0 }}>⚠</span>
      <span><strong>Sniper OFF</strong> — flip the toggle in Settings to start.</span>
    </div>
  );

  if (config.groupIds.length === 0) return (
    <div style={mkStyle('var(--warn)')}>
      <span style={{ flexShrink: 0 }}>⚠</span>
      <span><strong>No groups watched.</strong> Open inbox, select a group, click + Watch.</span>
    </div>
  );

  if (!tgConnected) return (
    <div style={mkStyle('var(--warn)')}>
      <span style={{ flexShrink: 0 }}>⚠</span>
      <span><strong>Telegram offline.</strong> Connect your account in the Telegram panel.</span>
    </div>
  );

  return null;
}

/* ─────────────────────────────────────────────────────────────
   Status bar
───────────────────────────────────────────────────────────── */
function StatusBar({ tg, session, config, onKill, killing }: {
  tg: TgStatus | null;
  session: { active: boolean; address?: string; balanceLamports?: number };
  config: SnipeConfig | null;
  onKill: () => void;
  killing: boolean;
}) {
  const solBalance = session.balanceLamports !== undefined ? session.balanceLamports / 1e9 : null;
  const lowBalance = solBalance !== null && solBalance < 0.005;
  const isLive = !!(session.active && config?.enabled && tg?.connected);

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2 flex-wrap justify-end">
        {tg?.connected
          ? <span className="chip chip-ok">TG Live</span>
          : <span className="chip chip-bad">TG offline</span>}
        {session.active
          ? <span className="chip chip-ok">Session ready</span>
          : <span className="chip" style={{ color: 'var(--text-3)' }}>No session</span>}
        {isLive
          ? (
            <span className="chip" style={{
              color: '#ef4444', fontWeight: 700, fontSize: 11,
              borderColor: 'color-mix(in srgb, #ef4444 40%, var(--border))',
              background: 'color-mix(in srgb, #ef4444 12%, var(--surface-2))',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', background: '#ef4444', flexShrink: 0,
                animation: 'kill-pulse 1.4s ease-in-out infinite',
              }} />
              LIVE
            </span>
          )
          : config?.enabled
            ? <span className="chip chip-accent" style={{ fontWeight: 600 }}>Sniper ON</span>
            : <span className="chip" style={{ color: 'var(--text-3)' }}>Sniper OFF</span>
        }
      </div>
      {session.active && solBalance !== null && (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px]" style={{ color: lowBalance ? 'var(--warn)' : 'var(--text-3)' }}>
            {solBalance.toFixed(4)} SOL
          </span>
          {lowBalance && (
            <span className="chip chip-warn" style={{ fontSize: 10 }}>Low balance</span>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Telegram auth panel
───────────────────────────────────────────────────────────── */
type AuthStep =
  | 'idle'          // not started
  | 'qr'            // QR visible, polling
  | 'qr_2fa'        // QR scanned, needs cloud password
  | 'phone_input'   // phone number entry
  | 'phone_code'    // OTP code entry
  | 'phone_2fa';    // 2FA after code verified

function TgPanel(props: { status: TgStatus | null; headerRight?: React.ReactNode }) {
  const { status } = props;
  const connected = status?.connected ?? false;
  const [step, setStep]   = useState<AuthStep>('idle');
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode]   = useState('');
  const [pw, setPw]       = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState<string | null>(null);
  const [resend, setResend] = useState(0);
  const [codeViaApp, setCodeViaApp] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { if (connected) { stopPoll(); reset(); } }, [connected]);
  useEffect(() => () => stopPoll(), []);

  // Resend countdown
  useEffect(() => {
    if (resend <= 0) return;
    const t = setTimeout(() => setResend((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resend]);

  function reset() { stopPoll(); setStep('idle'); setQrUrl(null); setErr(null); setCode(''); setPw(''); }
  function stopPoll() { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } }

  function startPoll() {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await api.get<{ status: string; qrUrl?: string; error?: string }>('/snipe/tg/qr/poll');
        if (data.qrUrl) setQrUrl(data.qrUrl);
        if (data.status === 'success') {
          stopPoll(); reset();
          mutate<TgStatus>('/snipe/tg/status', () => ({ connected: true, me: null, qrPending: false }));
          invalidate('/snipe/tg/status');
        } else if (data.status === 'needs_2fa') { stopPoll(); setStep('qr_2fa'); }
        else if (data.status === 'error') { stopPoll(); setErr(data.error ?? 'Login failed'); setStep('idle'); setQrUrl(null); }
      } catch {}
    }, 2500);
  }

  // QR flow
  const startQr = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/snipe/tg/qr/start', {});
      const { data } = await api.get<{ status: string; qrUrl?: string }>('/snipe/tg/qr/poll');
      setQrUrl(data.qrUrl ?? null); setStep('qr'); startPoll();
    } catch (e: any) { setErr(e?.response?.data?.message ?? e?.message ?? 'Failed to start QR login'); }
    finally { setBusy(false); }
  };

  const submitQr2fa = async () => {
    setBusy(true); setErr(null);
    try { await api.post('/snipe/tg/qr/verify-2fa', { password: pw }); startPoll(); setStep('qr'); }
    catch (e: any) { setErr(e?.response?.data?.message ?? e?.message ?? 'Wrong password'); }
    finally { setBusy(false); }
  };

  const cancelQr = async () => { stopPoll(); await api.delete('/snipe/tg/qr/cancel').catch(() => {}); reset(); };

  // Phone flow
  const sendCode = async () => {
    if (busy || phone.length < 7) return;
    setBusy(true); setErr(null);
    try {
      const { data } = await api.post<{ sent: boolean; isCodeViaApp: boolean }>('/snipe/tg/send-code', { phoneNumber: phone });
      setCodeViaApp(data.isCodeViaApp ?? true);
      setStep('phone_code'); setResend(60);
    } catch (e: any) { setErr(e?.response?.data?.message ?? e?.message ?? 'Failed to send code'); }
    finally { setBusy(false); }
  };

  const verifyCode = async () => {
    if (busy || code.length < 4) return;
    setBusy(true); setErr(null);
    try {
      const { data } = await api.post<{ ok: boolean; needs2fa?: boolean }>('/snipe/tg/verify-code', { code });
      if (data.needs2fa) { setStep('phone_2fa'); }
      else { invalidate('/snipe/tg/status'); reset(); }
    } catch (e: any) { setErr(e?.response?.data?.message ?? e?.message ?? 'Invalid code'); }
    finally { setBusy(false); }
  };

  const submitPhone2fa = async () => {
    if (busy || !pw) return;
    setBusy(true); setErr(null);
    try {
      await api.post('/snipe/tg/verify-2fa', { password: pw });
      invalidate('/snipe/tg/status'); reset();
    } catch (e: any) { setErr(e?.response?.data?.message ?? e?.message ?? 'Wrong password'); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    setBusy(true); setErr(null);
    try { await api.delete('/snipe/tg/session'); invalidate('/snipe/tg/status'); }
    catch (e: any) { setErr(e?.message ?? 'Error'); }
    finally { setBusy(false); }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="panel" style={{ padding: 0 }}>
      <div style={{ padding: '7px 10px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <IcoTelegram size={12} />
        <h2 style={{ margin: 0, flex: 1, fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>Telegram</h2>
        {connected && <span className="chip chip-ok" style={{ fontSize: 8, padding: '1px 5px' }}>Live</span>}
        {props.headerRight}
      </div>

      <div style={{ padding: 12 }}>
        {/* ── CONNECTED ── */}
        {connected ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border)' }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
                color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700,
              }}>
                {status?.me?.firstName?.[0]?.toUpperCase() ?? '?'}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="text-[12px] font-semibold truncate">{status?.me?.firstName ?? 'Connected'}</div>
                <div className="font-mono text-[10px] truncate" style={{ color: 'var(--text-3)' }}>
                  {status?.me?.username ? `@${status.me.username}` : status?.me?.phone ?? '—'}
                </div>
              </div>
            </div>
            {err && <p className="text-[11px]" style={{ color: 'var(--bad)' }}>{err}</p>}
            <button className="btn btn-sm btn-ghost" onClick={disconnect} disabled={busy}
              style={{ fontSize: 11, height: 26, color: 'var(--bad)', borderColor: 'color-mix(in srgb, var(--bad) 28%, transparent)' }}>
              {busy ? <Spinner size={10} /> : 'Disconnect'}
            </button>
          </div>

        /* ── QR CODE (active) ── */
        ) : step === 'qr' ? (
          <div className="space-y-3">
            <div className="text-[11px] font-mono uppercase tracking-widest" style={{ color: 'var(--text-3)' }}>
              Telegram → Settings → Devices → Scan QR
            </div>
            <div className="flex justify-center">
              {qrUrl ? (
                <div style={{ background: '#fff', padding: 12, borderRadius: 12, border: '1px solid var(--border)', boxShadow: 'inset 0 1px 0 var(--highlight)' }}>
                  <QRCode value={qrUrl} size={168} fgColor="#0a0d14" bgColor="#ffffff" />
                </div>
              ) : (
                <div className="flex items-center justify-center" style={{ width: 192, height: 192, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface-2)' }}>
                  <Spinner size={22} />
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 justify-center" style={{ color: 'var(--text-3)' }}>
              <Spinner size={10} />
              <span className="text-[11.5px] font-mono">Waiting for scan…</span>
            </div>
            {err && <p className="text-[12px] text-center" style={{ color: 'var(--bad)' }}>{err}</p>}
            <button className="btn btn-ghost btn-sm w-full" onClick={cancelQr}>Cancel</button>
          </div>

        /* ── QR 2FA ── */
        ) : step === 'qr_2fa' ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2" style={{ padding: '8px 10px', background: 'color-mix(in srgb, var(--warn) 10%, var(--surface-2))', borderRadius: 8, border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)' }}>
              <span style={{ color: 'var(--warn)', fontSize: 15 }}>⚠</span>
              <span className="text-[12px]" style={{ color: 'var(--warn)' }}>Two-step verification required</span>
            </div>
            <p className="text-[12px]" style={{ color: 'var(--text-2)' }}>Enter your Telegram cloud password to continue.</p>
            <input className="input" type="password" placeholder="Cloud password" autoFocus
              value={pw} onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitQr2fa()} />
            {err && <p className="text-[12px]" style={{ color: 'var(--bad)' }}>{err}</p>}
            <div className="flex gap-2">
              <button className="btn btn-ghost btn-sm flex-1" onClick={cancelQr} disabled={busy}>Cancel</button>
              <button className="btn btn-primary flex-1" onClick={submitQr2fa} disabled={busy || !pw}>
                {busy ? <Spinner size={12} /> : 'Confirm →'}
              </button>
            </div>
          </div>

        /* ── PHONE 2FA ── */
        ) : step === 'phone_2fa' ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <button onClick={() => { setStep('phone_code'); setErr(null); setPw(''); }}
                className="btn btn-ghost btn-sm" style={{ padding: '0 8px', height: 26, fontSize: 11 }}>← back</button>
              <span className="text-[11.5px] font-mono" style={{ color: 'var(--text-3)' }}>Two-step verification</span>
            </div>
            <p className="text-[12px]" style={{ color: 'var(--text-2)' }}>Enter your Telegram cloud password.</p>
            <input className="input" type="password" placeholder="Cloud password" autoFocus
              value={pw} onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitPhone2fa()} />
            {err && <p className="text-[12px]" style={{ color: 'var(--bad)' }}>{err}</p>}
            <button className="btn btn-primary w-full" onClick={submitPhone2fa} disabled={busy || !pw}>
              {busy ? <Spinner size={12} /> : 'Confirm →'}
            </button>
          </div>

        /* ── PHONE CODE ENTRY ── */
        ) : step === 'phone_code' ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <button onClick={() => { setStep('phone_input'); setErr(null); setCode(''); }}
                className="btn btn-ghost btn-sm" style={{ padding: '0 8px', height: 26, fontSize: 11 }}>← back</button>
              <span className="text-[11.5px] font-mono" style={{ color: 'var(--text-3)' }}>Code sent to {phone}</span>
            </div>
            {codeViaApp ? (
              <div style={{ background: 'color-mix(in srgb, var(--accent) 8%, var(--surface-2))', border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)', borderRadius: 10, padding: '10px 12px' }}>
                <div className="flex items-center gap-2 mb-2">
                  <IcoTelegram size={13} />
                  <span className="text-[12px] font-semibold">Check your Telegram app</span>
                </div>
                <ol className="text-[11.5px] space-y-1" style={{ color: 'var(--text-2)', paddingLeft: 16, listStyleType: 'decimal' }}>
                  <li>Open the <strong>Telegram</strong> app on your phone</li>
                  <li>Look for a message from <strong>"Telegram"</strong> in your chat list</li>
                  <li>The message will say: <span className="font-mono" style={{ color: 'var(--accent)' }}>Login code: XXXXX</span></li>
                </ol>
              </div>
            ) : (
              <div style={{ background: 'color-mix(in srgb, var(--ok) 8%, var(--surface-2))', border: '1px solid color-mix(in srgb, var(--ok) 25%, transparent)', borderRadius: 10, padding: '10px 12px' }}>
                <div className="flex items-center gap-2">
                  <span style={{ color: 'var(--ok)' }}>✓</span>
                  <span className="text-[11.5px]" style={{ color: 'var(--text-2)' }}>Code sent via SMS to {phone}</span>
                </div>
              </div>
            )}
            <label className="label">5-digit code</label>
            <input className="input font-mono text-center"
              style={{ fontSize: 20, letterSpacing: '0.3em', height: 44 }}
              inputMode="numeric" placeholder="·····" maxLength={6} autoFocus
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => e.key === 'Enter' && verifyCode()} />
            {err && <p className="text-[12px] text-center" style={{ color: 'var(--bad)' }}>{err}</p>}
            <button className="btn btn-primary w-full" onClick={verifyCode} disabled={busy || code.length < 4}>
              {busy ? <Spinner size={12} /> : 'Verify code →'}
            </button>
            <div className="text-[11.5px] font-mono text-center" style={{ color: 'var(--text-3)' }}>
              {resend > 0 ? `Resend in ${resend}s` : (
                <button onClick={() => { setStep('phone_input'); setErr(null); setCode(''); }}
                  style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit' }}>
                  Resend code
                </button>
              )}
            </div>
          </div>

        /* ── IDLE: QR primary + phone secondary ── */
        ) : (
          <div className="space-y-4">
            <p className="text-[12.5px]" style={{ color: 'var(--text-2)' }}>
              Connect your personal Telegram account to monitor groups in real-time.
            </p>

            {err && (
              <div className="px-3 py-2 rounded-lg text-[12px]"
                style={{ background: 'color-mix(in srgb, var(--bad) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--bad) 35%, transparent)', color: 'var(--bad)' }}>
                {err}
              </div>
            )}

            {/* Primary: QR code */}
            <div style={{ padding: '14px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'inset 0 1px 0 var(--highlight)' }}>
              <div className="flex items-center gap-2 mb-3">
                <IcoQr size={14} />
                <span className="text-[12px] font-semibold">Scan QR code</span>
                <span className="chip chip-accent" style={{ fontSize: 10, marginLeft: 'auto' }}>Recommended</span>
              </div>
              <p className="text-[11.5px] mb-3" style={{ color: 'var(--text-3)' }}>
                Open Telegram → Settings → Devices → Link desktop device
              </p>
              <button className="btn btn-primary w-full" onClick={startQr} disabled={busy}>
                {busy ? <><Spinner size={12} /><span>Starting…</span></> : <><IcoQr size={13} /><span>Start QR scan</span></>}
              </button>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--text-3)' }}>or</span>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            </div>

            {/* Secondary: phone + OTP */}
            <div>
              <label className="label">Sign in with phone number</label>
              <div className="flex gap-2">
                <input className="input flex-1" type="tel" inputMode="numeric"
                  placeholder="+1 555 000 0000"
                  value={phone} onChange={(e) => setPhone(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && phone.length >= 7 && sendCode()}
                  disabled={busy} />
                <button className="btn btn-ghost btn-sm shrink-0"
                  style={{ height: 32, minWidth: 86, borderColor: 'color-mix(in srgb, var(--accent) 35%, var(--border))' }}
                  onClick={sendCode} disabled={busy || phone.length < 7}>
                  {busy ? <Spinner size={11} /> : 'Send code'}
                </button>
              </div>
              <p className="text-[11px] mt-1.5 font-mono" style={{ color: 'var(--text-3)' }}>
                Include country code · code delivered via Telegram app, not SMS
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Config panel — Buy / Sell tabs only
───────────────────────────────────────────────────────────── */
const SELL_STRATEGIES = [
  { label: 'Conservative', tp: 100, sl: -25, trail: null, exit: 20 * 60_000 },
  { label: 'Aggressive',   tp: 400, sl: -30, trail: 20,   exit: null },
  { label: 'Scalp',        tp: 50,  sl: -15, trail: null,  exit: 5 * 60_000 },
] as const;

/** Strip Prisma-only fields before sending to the API (forbidNonWhitelisted rejects them). */
function toSnipeDto(c: SnipeConfig) { return toSnipeDtoSafe(c); }

function ConfigPanel({ config, wallets }: { config: SnipeConfig | null; wallets: Wallet[] }) {
  const [form, setForm] = useState<SnipeConfig>({
    enabled: false, chain: 'SOLANA', walletId: '', buyAmountRaw: '100000000',
    maxSlippageBps: 5000, groupIds: [], skipSafety: true, dedupeWindowMs: 30000,
    notifyOnBuy: true, matchPattern: null, sellEnabled: true, sellMode: 'TRIGGER',
    takeProfitPct: null, stopLossPct: null, trailingStopPct: null, exitAfterMs: null, partialExitPct: null,
  });
  // Human-readable display values (SOL, %, seconds)
  const [solInput,  setSolInput]  = useState('0.1000');
  const [slipInput, setSlipInput] = useState('50.0');
  const [tab, setTab]             = useState<'buy' | 'sell'>('buy');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimer                 = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userModified              = useRef(false);

  // Sync from server
  useEffect(() => {
    if (config) {
      userModified.current = false;
      setSolInput((Number(config.buyAmountRaw) / 1e9).toFixed(4));
      setSlipInput((config.maxSlippageBps / 100).toFixed(1));
      setForm((f) => ({ ...f, ...config, walletId: config.walletId || f.walletId }));
    }
  }, [config]);

  // Autosave — 500 ms debounce
  useEffect(() => {
    if (!userModified.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveState('saving');
      try {
        await api.put('/snipe/config', toSnipeDto(form));
        setSaveState('saved');
        invalidate('/snipe/config');
        setTimeout(() => setSaveState('idle'), 1200);
      } catch {
        setSaveState('error');
        setTimeout(() => setSaveState('idle'), 3000);
      }
    }, 500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [form]);

  const set = <K extends keyof SnipeConfig>(k: K, v: SnipeConfig[K]) => {
    userModified.current = true;
    setForm((f) => ({ ...f, [k]: v }));
  };

  // SOL input: display in SOL, store as lamports string
  const handleSolInput = (raw: string) => {
    setSolInput(raw);
    const n = parseFloat(raw);
    if (!isNaN(n) && n > 0) {
      userModified.current = true;
      setForm((f) => ({ ...f, buyAmountRaw: String(Math.round(n * 1e9)) }));
    }
  };

  // Slippage input: display as %, store as bps
  const handleSlipInput = (raw: string) => {
    setSlipInput(raw);
    const n = parseFloat(raw);
    if (!isNaN(n) && n > 0) {
      userModified.current = true;
      setForm((f) => ({ ...f, maxSlippageBps: Math.round(n * 100) }));
    }
  };

  const applyStrategy = (s: typeof SELL_STRATEGIES[number]) => {
    userModified.current = true;
    setForm((f) => ({ ...f, takeProfitPct: s.tp, stopLossPct: s.sl, trailingStopPct: s.trail ?? null, exitAfterMs: s.exit ?? null }));
  };

  const filteredWallets = wallets.filter((w) => w.chain === form.chain);

  const inputUnit = (unit: string) => (
    <span style={{
      position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
      fontSize: 11, fontWeight: 600, color: 'var(--text-3)', pointerEvents: 'none',
      fontFamily: 'var(--font-mono)',
    }}>{unit}</span>
  );

  return (
    <div className="panel space-y-0" style={{ padding: 0 }}>
      {/* Header row */}
      <div style={{ borderBottom: '1px solid var(--border)', padding: '9px 12px' }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="section-title" style={{ flex: 1 }}>Settings</span>
          <div className="flex items-center gap-1">
            {(['buy', 'sell'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className="btn btn-ghost btn-sm"
                style={{
                  fontSize: 11, fontWeight: tab === t ? 700 : 400,
                  height: 24, padding: '0 8px', borderRadius: 5,
                  color: tab === t ? 'var(--accent)' : 'var(--text-3)',
                  background: tab === t ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                  border: tab === t ? '1px solid color-mix(in srgb, var(--accent) 28%, transparent)' : '1px solid transparent',
                }}>
                {t === 'buy' ? 'Buy' : 'Sell'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} />
            <span className="text-[11px] font-mono" style={{
              color: saveState === 'saved' ? 'var(--ok)' : saveState === 'error' ? 'var(--bad)' : form.enabled ? 'var(--ok)' : 'var(--text-3)',
              minWidth: 42, textAlign: 'right',
            }}>
              {saveState === 'saving' ? '…' : saveState === 'saved' ? '✓' : saveState === 'error' ? 'err' : form.enabled ? 'ON' : 'OFF'}
            </span>
          </div>
        </div>
      </div>

      <div style={{ padding: '12px' }}>
        {tab === 'buy' && (
          <div className="space-y-3">
            {/* Wallet */}
            <div>
              <label className="label" style={{ fontSize: 10 }}>Signing wallet</label>
              <select className="input" style={{ height: 30, fontSize: 12 }} value={form.walletId} onChange={(e) => set('walletId', e.target.value)}>
                <option value="">Select wallet…</option>
                {filteredWallets.map((w) => (
                  <option key={w.id} value={w.id}>{w.label ?? `${w.address.slice(0, 8)}…${w.address.slice(-4)}`}</option>
                ))}
              </select>
              {filteredWallets.length === 0 && (
                <p className="text-[10px] mt-1" style={{ color: 'var(--warn)' }}>No Solana wallets — create one on the Wallets page.</p>
              )}
            </div>

            {/* Buy size + Slippage side by side */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" style={{ fontSize: 10 }}>Buy size</label>
                <div style={{ position: 'relative' }}>
                  <input className="input font-mono" type="number" step="0.001" min="0.001"
                    value={solInput}
                    onChange={(e) => handleSolInput(e.target.value)}
                    style={{ height: 30, fontSize: 12, paddingRight: 36 }} />
                  {inputUnit('SOL')}
                </div>
              </div>
              <div>
                <label className="label" style={{ fontSize: 10 }}>Max slippage</label>
                <div style={{ position: 'relative' }}>
                  <input className="input font-mono" type="number" step="0.5" min="0.5" max="90"
                    value={slipInput}
                    onChange={(e) => handleSlipInput(e.target.value)}
                    style={{ height: 30, fontSize: 12, paddingRight: 24 }} />
                  {inputUnit('%')}
                </div>
              </div>
            </div>

            {/* Flags */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {([
                { k: 'skipSafety'  as const, label: 'Skip rug-check', hint: 'max speed' },
                { k: 'notifyOnBuy' as const, label: 'Notify on buy',  hint: 'Telegram msg' },
              ] as const).map(({ k, label, hint }) => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form[k] as boolean} onChange={(e) => set(k, e.target.checked)}
                    className="accent-[color:var(--accent)]" style={{ width: 13, height: 13 }} />
                  <span className="text-[12px]">{label}</span>
                  <span className="font-mono text-[10px]" style={{ color: 'var(--text-3)' }}>{hint}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {tab === 'sell' && (
          <div className="space-y-3">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div className="text-[12px] font-semibold">Auto-sell</div>
                <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>Exit positions automatically</div>
              </div>
              <Toggle checked={form.sellEnabled} onChange={(v) => set('sellEnabled', v)} />
            </div>
            {form.sellEnabled && (
              <>
                {/* Mode */}
                <div className="grid grid-cols-2 gap-1.5">
                  {(['TRIGGER', 'INTELLIGENT'] as const).map((m) => (
                    <button key={m} onClick={() => set('sellMode', m)}
                      style={{
                        padding: '7px 8px', borderRadius: 7, textAlign: 'left', cursor: 'pointer',
                        background: form.sellMode === m ? 'color-mix(in srgb, var(--accent) 14%, var(--surface-2))' : 'var(--surface-2)',
                        border: `1px solid ${form.sellMode === m ? 'color-mix(in srgb, var(--accent) 35%, transparent)' : 'var(--border)'}`,
                      }}>
                      <div className="font-semibold text-[11px]" style={{ color: form.sellMode === m ? 'var(--accent)' : 'var(--text)' }}>{m}</div>
                      <div className="text-[10px]" style={{ color: 'var(--text-3)', marginTop: 1 }}>
                        {m === 'TRIGGER' ? 'Instant on trigger' : 'AI reviews first'}
                      </div>
                    </button>
                  ))}
                </div>

                {/* Quick strategies */}
                <div>
                  <div className="label" style={{ fontSize: 10, marginBottom: 4 }}>Quick preset</div>
                  <div className="flex flex-wrap gap-1">
                    {SELL_STRATEGIES.map((s) => (
                      <button key={s.label}
                        onClick={() => applyStrategy(s)}
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 10, height: 22, padding: '0 8px' }}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Triggers */}
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <TriggerRow label="Take profit" unit="%" value={form.takeProfitPct} onChange={(v) => set('takeProfitPct', v)} min={1} max={10000} />
                  <TriggerRow label="Stop loss"   unit="%" value={form.stopLossPct}   onChange={(v) => set('stopLossPct', v)}   min={-99} max={-1} />
                  <TriggerRow label="Trail stop"  unit="%" value={form.trailingStopPct} onChange={(v) => set('trailingStopPct', v)} min={1} max={99} />
                  <TriggerRow label="Time exit"   unit="min"
                    value={form.exitAfterMs != null ? form.exitAfterMs / 60_000 : null}
                    onChange={(v) => set('exitAfterMs', v != null ? Math.round(v * 60_000) : null)}
                    min={1} max={1440} />
                </div>
              </>
            )}
          </div>
        )}
        {saveState === 'error' && <p className="text-[11px] mt-2" style={{ color: 'var(--bad)' }}>Save failed — check connection</p>}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Telegram inbox — full group list + message stream
───────────────────────────────────────────────────────────── */
const INBOX_HEIGHT = 560;
const SOL_CA_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const EVM_CA_RE = /\b0x[a-fA-F0-9]{40}\b/gi;

function groupInitialColor(groupId: string): string {
  const palette = ['#3b82f6', '#a855f7', '#22c55e', '#f59e0b', '#06b6d4', '#ec4899', '#8b5cf6'];
  const hash = [...groupId].reduce((a, c) => a + c.charCodeAt(0), 0);
  return palette[hash % palette.length];
}

function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function highlightCAs(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const combined = new RegExp(`${SOL_CA_RE.source}|${EVM_CA_RE.source}`, 'gi');
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = combined.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const addr = match[0];
    parts.push(
      <span key={match.index} style={{
        fontFamily: 'var(--font-mono)', fontSize: 11,
        color: 'var(--accent)',
        background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)',
        borderRadius: 4, padding: '1px 5px', display: 'inline-block',
        letterSpacing: '0.01em',
      }}>
        {addr.slice(0, 6)}…{addr.slice(-4)}
      </span>
    );
    last = match.index + addr.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function TgInboxPanel({ config, tgConnected, session, headerRight }: { config: SnipeConfig | null; tgConnected: boolean; session: { active: boolean; balanceLamports?: number }; headerRight?: React.ReactNode }) {
  const solBalance = session.balanceLamports !== undefined ? session.balanceLamports / 1e9 : null;
  const snipeWillRun = config?.enabled && session.active && tgConnected && (solBalance === null || solBalance >= 0.005);
  const snipeWarning = config?.enabled && tgConnected
    ? !session.active
      ? 'No hot session — trades will be skipped. Load a hot session in Snipe settings.'
      : solBalance !== null && solBalance < 0.005
        ? `Wallet balance ${solBalance.toFixed(4)} SOL is too low — transactions will be dropped by validators. Fund the wallet first.`
        : null
    : null;
  const [groups, setGroups]       = useState<TgGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [overrides, setOverrides] = useState(new Map<string, GroupOverride>());
  const [selected, setSelected]   = useState<string | null>(null);
  const [messages, setMessages]   = useState(new Map<string, TgMessage[]>());
  const [unread, setUnread]       = useState(new Map<string, number>());
  const [msgLoading, setMsgLoading] = useState(false);
  const [search, setSearch]       = useState('');
  // Local copy of groupIds for optimistic updates
  const [localGroupIds, setLocalGroupIds] = useState<string[]>(config?.groupIds ?? []);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Sync localGroupIds when config changes from server
  useEffect(() => { if (config) setLocalGroupIds(config.groupIds); }, [config]);

  // Load groups + overrides when TG connects
  useEffect(() => {
    if (!tgConnected) { setGroups([]); return; }
    setGroupsLoading(true);
    Promise.all([
      api.get<TgGroup[]>('/snipe/tg/groups'),
      api.get<GroupOverride[]>('/snipe/groups'),
    ]).then(([{ data: g }, { data: o }]) => {
      setGroups(g);
      setOverrides(new Map(o.map((ov) => [ov.groupId, ov])));
    }).catch(() => {}).finally(() => setGroupsLoading(false));
  }, [tgConnected]);

  // Load message history when group selected
  useEffect(() => {
    if (!selected) return;
    setUnread((prev) => { const m = new Map(prev); m.delete(selected); return m; });
    if (messages.has(selected)) return;
    setMsgLoading(true);
    api.get<TgMessage[]>(`/snipe/tg/groups/${selected}/messages?limit=50`)
      .then(({ data }) => setMessages((prev) => new Map(prev).set(selected, data)))
      .catch(() => {})
      .finally(() => setMsgLoading(false));
  }, [selected]);

  // Real-time: route incoming messages to the right group
  useRealtime('tg_message', useCallback((evt: any) => {
    const { groupId, text, ts, messageId } = evt;
    if (!groupId || !text) return;
    const newMsg: TgMessage = { id: messageId ?? ts, text, ts, fromId: evt.fromId ?? '', senderName: evt.senderName };

    setMessages((prev) => {
      const existing = prev.get(groupId) ?? [];
      const updated  = [...existing, newMsg].slice(-200);
      return new Map(prev).set(groupId, updated);
    });

    // Update last-message preview + bubble the group to top of list
    setGroups((prev) => {
      const updated = prev.map((g) =>
        g.id === groupId ? { ...g, lastMessage: { text: text.slice(0, 80), ts } } : g,
      );
      // Move the group with a new message to the top (Telegram-style)
      const idx = updated.findIndex((g) => g.id === groupId);
      if (idx > 0) {
        const [moved] = updated.splice(idx, 1);
        return [moved, ...updated];
      }
      return updated;
    });

    // Increment unread badge if not currently viewing this group
    if (groupId !== selectedRef.current) {
      setUnread((prev) => { const m = new Map(prev); m.set(groupId, (m.get(groupId) ?? 0) + 1); return m; });
    }
  }, []));

  // Track / un-track a group
  const toggleTrack = async (groupId: string, track: boolean) => {
    const base = config ?? {
      enabled: false, chain: 'SOLANA' as const, walletId: '',
      buyAmountRaw: '100000000', maxSlippageBps: 5000, groupIds: [],
      skipSafety: true, dedupeWindowMs: 30000, notifyOnBuy: true, matchPattern: null,
      sellEnabled: true, sellMode: 'TRIGGER' as const,
      takeProfitPct: null, stopLossPct: null, trailingStopPct: null, exitAfterMs: null, partialExitPct: null,
    };
    const newIds = track
      ? [...new Set([...localGroupIds, groupId])]
      : localGroupIds.filter((id) => id !== groupId);
    setLocalGroupIds(newIds); // optimistic
    try {
      await api.put('/snipe/config', toSnipeDto({ ...base, groupIds: newIds } as SnipeConfig));
      invalidate('/snipe/config');
    } catch {
      setLocalGroupIds(config?.groupIds ?? []); // rollback
    }
  };

  // Save per-group match pattern
  const savePattern = async (groupId: string, groupTitle: string, pattern: string | null) => {
    const ov = overrides.get(groupId);
    await api.put(`/snipe/groups/${encodeURIComponent(groupId)}`, {
      groupId, groupTitle, enabled: ov?.enabled ?? true,
      buyAmountRaw: ov?.buyAmountRaw ?? undefined,
      maxSlippageBps: ov?.maxSlippageBps ?? undefined,
      sellMode: ov?.sellMode ?? undefined,
      takeProfitPct: ov?.takeProfitPct ?? undefined,
      stopLossPct: ov?.stopLossPct ?? undefined,
      trailingStopPct: ov?.trailingStopPct ?? undefined,
      exitAfterMs: ov?.exitAfterMs ?? undefined,
      matchPattern: pattern,
    });
    setOverrides((prev) => new Map(prev).set(groupId, { ...ov, groupId, groupTitle, matchPattern: pattern } as GroupOverride));
    invalidate('/snipe/groups');
  };

  const filtered = groups.filter((g) =>
    !search || g.title.toLowerCase().includes(search.toLowerCase()),
  );

  const selectedGroup = groups.find((g) => g.id === selected) ?? null;
  const selectedMsgs  = messages.get(selected ?? '') ?? [];
  const isWatching    = (id: string) => localGroupIds.includes(id);

  return (
    <div className="panel" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Panel header */}
      <div style={{ padding: '7px 10px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <IcoTelegram size={12} />
        <span style={{ fontSize: 11, fontWeight: 600, flex: 1, color: 'var(--text)' }}>Inbox</span>
        {tgConnected && <span className="live-dot" />}
        {snipeWillRun && <span className="chip chip-ok" style={{ fontSize: 8, padding: '1px 5px' }}>Sniping</span>}
        {groups.length > 0 && (
          <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>
            {localGroupIds.length}/{groups.length}
          </span>
        )}
        {headerRight}
      </div>

      {/* No-session warning — snipe is on but wallet key not loaded */}
      {snipeWarning && (
        <div style={{
          padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8,
          background: 'color-mix(in srgb, var(--warn) 10%, var(--surface-2))',
          borderBottom: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)',
        }}>
          <span style={{ color: 'var(--warn)', fontSize: 13 }}>⚠</span>
          <span className="text-[11px]" style={{ color: 'var(--warn)' }}>{snipeWarning}</span>
        </div>
      )}

      {!tgConnected ? (
        <div style={{ flex: 1, minHeight: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IcoTelegram size={32} />
            <p className="text-[13px] font-medium mt-3">Connect Telegram to see your groups</p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>Use the panel on the left to scan the QR code.</p>
          </div>
        </div>
      ) : (
        <div className="tg-inbox-panes" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* ── Left: group list ── */}
          <div className="tg-inbox-groups-col" style={{ width: 224, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            {/* Search */}
            <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
              <input
                className="input"
                style={{ height: 28, fontSize: 12, padding: '0 8px' }}
                placeholder="Search groups…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {/* Group rows — virtual scroll, fixed GROUP_ROW_H per item */}
            <GroupVirtualList
              items={filtered}
              loading={groupsLoading}
              search={search}
              selected={selected}
              unread={unread}
              localGroupIds={localGroupIds}
              onSelect={setSelected}
            />
          </div>

          {/* ── Right: chat view ── */}
          <div className="tg-inbox-chat-col" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {!selected ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ textAlign: 'center', padding: 24 }}>
                  <p className="text-[13px] font-medium">Select a group</p>
                  <p className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>
                    Click any group to see messages · mark groups for sniping
                  </p>
                </div>
              </div>
            ) : (
              <>
                {/* Chat header */}
                <ChatHeader
                  group={selectedGroup}
                  watching={isWatching(selected)}
                  override={overrides.get(selected) ?? null}
                  onToggleTrack={(t) => toggleTrack(selected, t)}
                  onSavePattern={(p) => savePattern(selected, selectedGroup?.title ?? '', p)}
                />

                {/* Messages */}
                <MessageList messages={selectedMsgs} loading={msgLoading} groupId={selected} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Chat header — group info + Watch toggle + match criterion
───────────────────────────────────────────────────────────── */
function ChatHeader({ group, watching, override, onToggleTrack, onSavePattern }: {
  group: TgGroup | null;
  watching: boolean;
  override: GroupOverride | null;
  onToggleTrack: (t: boolean) => void;
  onSavePattern: (p: string | null) => void;
}) {
  const [pattern, setPattern]     = useState(override?.matchPattern ?? '');
  const [patMode, setPatMode]     = useState<'ca' | 'custom'>(override?.matchPattern ? 'custom' : 'ca');
  const [patternSaved, setPatternSaved] = useState(false);
  const [busy, setBusy]           = useState(false);

  useEffect(() => {
    setPattern(override?.matchPattern ?? '');
    setPatMode(override?.matchPattern ? 'custom' : 'ca');
  }, [override?.matchPattern]);

  const savePattern = async () => {
    setBusy(true);
    try {
      await onSavePattern(patMode === 'custom' && pattern ? pattern : null);
      setPatternSaved(true);
      setTimeout(() => setPatternSaved(false), 1500);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ borderBottom: '1px solid var(--border)', padding: '10px 14px', flexShrink: 0 }}>
      {/* Group name row */}
      <div className="flex items-center gap-3">
        {group && (
          <div style={{
            width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
            background: `color-mix(in srgb, ${groupInitialColor(group.id)} 20%, var(--surface-2))`,
            border: `1px solid color-mix(in srgb, ${groupInitialColor(group.id)} 30%, transparent)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 600, color: groupInitialColor(group.id),
          }}>
            {group.title[0]?.toUpperCase() ?? '?'}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="text-[13px] font-semibold truncate">{group?.title ?? '…'}</div>
          {group?.members && (
            <div className="text-[11px] font-mono truncate" style={{ color: 'var(--text-3)' }}>
              {group.members.toLocaleString()} members · {group.isChannel ? 'channel' : 'group'} · id:{group.id}
            </div>
          )}
        </div>
        {/* Watch toggle */}
        <button
          onClick={() => onToggleTrack(!watching)}
          className={`btn btn-sm ${watching ? 'btn-primary' : 'btn-ghost'}`}
          style={{
            flexShrink: 0,
            borderColor: watching ? undefined : 'color-mix(in srgb, var(--ok) 40%, transparent)',
            color: watching ? undefined : 'var(--ok)',
          }}>
          {watching ? '● Watching' : '+ Watch'}
        </button>
      </div>

      {/* Match criterion (only shown when watching) */}
      {watching && (
        <div style={{ marginTop: 10, padding: '8px 10px', background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] font-medium" style={{ color: 'var(--text-2)' }}>Match criterion</span>
            <div className="flex gap-1">
              {(['ca', 'custom'] as const).map((m) => (
                <button key={m} onClick={() => setPatMode(m)}
                  className={`btn btn-sm ${patMode === m ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ height: 22, fontSize: 10, padding: '0 7px' }}>
                  {m === 'ca' ? 'CA address' : 'Custom regex'}
                </button>
              ))}
            </div>
          </div>

          {patMode === 'ca' ? (
            <p className="text-[11px]" style={{ color: 'var(--text-3)' }}>
              Snipe any message containing a contract address (default)
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <input
                className="input font-mono"
                style={{ flex: 1, height: 28, fontSize: 12 }}
                placeholder="e.g. contract|launch|sol|CA:"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && savePattern()}
              />
              <button className="btn btn-sm btn-ghost" onClick={savePattern} disabled={busy}
                style={{ flexShrink: 0, color: patternSaved ? 'var(--ok)' : undefined }}>
                {busy ? <Spinner size={10} /> : patternSaved ? '✓' : 'Save'}
              </button>
            </div>
          )}
          {patMode === 'ca' && override?.matchPattern && (
            <button className="text-[10px] mt-1" style={{ color: 'var(--text-3)' }} onClick={() => { setPattern(''); onSavePattern(null); }}>
              Clear custom pattern
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   GroupVirtualList — fixed GROUP_ROW_H per item
─────────────────────────────────────────────────────────────── */
function GroupVirtualList({ items, loading, search, selected, unread, localGroupIds, onSelect }: {
  items: TgGroup[];
  loading: boolean;
  search: string;
  selected: string | null;
  unread: Map<string, number>;
  localGroupIds: string[];
  onSelect: (id: string) => void;
}) {
  const virt = useVirtual(items.length, GROUP_ROW_H);

  if (loading) {
    return (
      <div style={{ flex: 1, padding: 8, overflow: 'hidden' }}>
        <div className="space-y-1">
          {[...Array(6)].map((_, i) => <Skeleton key={i} h={GROUP_ROW_H - 2} rounded="md" />)}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p className="text-[12px]" style={{ color: 'var(--text-3)' }}>{search ? 'No match' : 'No groups found'}</p>
      </div>
    );
  }

  return (
    <div
      ref={virt.ref}
      onScroll={virt.onScroll}
      style={{ flex: 1, overflowY: 'auto', overscrollBehavior: 'contain' }}
    >
      <div style={{ height: virt.total, position: 'relative' }}>
        {items.slice(virt.start, virt.end).map((g, i) => {
          const idx        = virt.start + i;
          const isSelected = selected === g.id;
          const watching   = localGroupIds.includes(g.id);
          const unreadCnt  = unread.get(g.id) ?? 0;
          const color      = groupInitialColor(g.id);
          return (
            <button
              key={g.id}
              onClick={() => onSelect(g.id)}
              style={{
                position: 'absolute', top: idx * GROUP_ROW_H, left: 0, right: 0,
                height: GROUP_ROW_H,
                display: 'flex', alignItems: 'center', gap: 9,
                padding: '0 10px', textAlign: 'left', cursor: 'pointer',
                background: isSelected ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
                borderLeft: isSelected ? '2px solid var(--accent)' : '2px solid transparent',
                borderBottom: '1px solid var(--border)',
                transition: 'background 120ms',
              }}
            >
              {/* Avatar */}
              <div style={{
                width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                background: `color-mix(in srgb, ${color} 20%, var(--surface-2))`,
                border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, fontWeight: 600, color,
              }}>
                {g.title[0]?.toUpperCase() ?? '?'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span className="text-[12px] font-semibold truncate" style={{ flex: 1, color: isSelected ? 'var(--accent)' : 'var(--text)' }}>
                    {g.title}
                  </span>
                  {g.lastMessage && (
                    <span className="text-[10px] font-mono" style={{ color: 'var(--text-3)', flexShrink: 0 }}>
                      {relativeTime(g.lastMessage.ts)}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                  {watching && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--ok)', flexShrink: 0 }} />}
                  <span className="text-[11px] truncate" style={{ color: 'var(--text-3)', flex: 1 }}>
                    {g.lastMessage?.text || (g.isChannel ? 'Channel' : 'Group')}
                  </span>
                  {unreadCnt > 0 && (
                    <span style={{
                      minWidth: 18, height: 18, borderRadius: 999, padding: '0 4px',
                      background: 'var(--accent)', color: '#fff', fontSize: 10,
                      fontFamily: 'var(--font-mono)', display: 'flex',
                      alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                      {unreadCnt > 99 ? '99+' : unreadCnt}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Message list — virtual scroll, fixed MSG_ROW_H, auto-scroll,
   CA highlighting, time separators
─────────────────────────────────────────────────────────────── */
type MsgItem =
  | { kind: 'sep';  key: string; ts: number }
  | { kind: 'msg';  key: string; msg: TgMessage; showSender: boolean };

function MessageList({ messages, loading, groupId }: { messages: TgMessage[]; loading: boolean; groupId: string }) {
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const prevLenRef = useRef(messages.length);

  // Flatten messages + time-separators into a single fixed-height item list
  const items = useMemo<MsgItem[]>(() => {
    const out: MsgItem[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg  = messages[i];
      const prev = messages[i - 1];
      const gap  = !prev || msg.ts - prev.ts > 5 * 60_000;
      if (gap) out.push({ kind: 'sep', key: `sep-${msg.ts}-${i}`, ts: msg.ts });
      const showSender = !!msg.senderName && (!prev || prev.fromId !== msg.fromId || gap);
      out.push({ kind: 'msg', key: `msg-${msg.id}`, msg, showSender });
    }
    return out;
  }, [messages]);

  const virt = useVirtual(items.length, MSG_ROW_H);

  // Track new unread when not at bottom
  useEffect(() => {
    const delta = messages.length - prevLenRef.current;
    prevLenRef.current = messages.length;
    if (delta > 0 && !atBottom) setNewCount((n) => n + delta);
  }, [messages.length, atBottom]);

  // Auto-scroll to bottom when new messages arrive and already at bottom
  useEffect(() => {
    const el = virt.ref.current;
    if (!el || !atBottom) return;
    el.scrollTop = items.length * MSG_ROW_H;
  }, [items.length, atBottom]);

  // Reset scroll position on group change
  useEffect(() => {
    const el = virt.ref.current;
    if (el) {
      el.scrollTop = items.length * MSG_ROW_H;
      setAtBottom(true);
      setNewCount(0);
      prevLenRef.current = messages.length;
    }
  }, [groupId]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    virt.onScroll(e);
    const el = e.currentTarget;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < MSG_ROW_H + 10;
    setAtBottom(isAtBottom);
    if (isAtBottom) setNewCount(0);
  };

  const scrollToBottom = () => {
    const el = virt.ref.current;
    if (el) { el.scrollTop = items.length * MSG_ROW_H; setAtBottom(true); setNewCount(0); }
  };

  if (loading) {
    return (
      <div style={{ flex: 1, padding: 14, overflow: 'hidden' }}>
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => <Skeleton key={i} h={MSG_ROW_H - 6} rounded="md" />)}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p className="text-[12px]" style={{ color: 'var(--text-3)' }}>No messages yet — new ones will appear here live.</p>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        ref={virt.ref}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        <div style={{ height: virt.total, position: 'relative' }}>
          {items.slice(virt.start, virt.end).map((item, i) => {
            const idx = virt.start + i;
            const top = idx * MSG_ROW_H;

            if (item.kind === 'sep') {
              const timeStr = new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              const isToday = new Date(item.ts).toDateString() === new Date().toDateString();
              return (
                <div key={item.key} style={{
                  position: 'absolute', top, left: 0, right: 0, height: MSG_ROW_H,
                  display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px',
                }}>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                  <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                    {isToday
                      ? timeStr
                      : new Date(item.ts).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                </div>
              );
            }

            const { msg, showSender } = item;
            const parts   = highlightCAs(msg.text);
            const hasCA   = parts.some((p) => typeof p !== 'string');
            const timeStr = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            return (
              <div key={item.key} style={{
                position: 'absolute', top, left: 0, right: 0, height: MSG_ROW_H,
                display: 'flex', alignItems: 'flex-start',
                padding: '5px 14px 0',
                background: hasCA ? 'color-mix(in srgb, var(--accent) 5%, transparent)' : 'transparent',
                borderLeft: hasCA ? '2px solid color-mix(in srgb, var(--accent) 35%, transparent)' : '2px solid transparent',
                overflow: 'hidden',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {showSender && (
                    <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--accent)', marginBottom: 1, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {msg.senderName}
                    </div>
                  )}
                  <div style={{
                    fontSize: 12, color: 'var(--text)', lineHeight: 1.45, wordBreak: 'break-word',
                    display: '-webkit-box', WebkitLineClamp: showSender ? 2 : 3,
                    WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  }}>
                    {parts}
                  </div>
                </div>
                <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', flexShrink: 0, marginLeft: 8, marginTop: 1, whiteSpace: 'nowrap' }}>
                  {timeStr}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Jump-to-bottom button */}
      {!atBottom && newCount > 0 && (
        <button
          onClick={scrollToBottom}
          style={{
            position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
            background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 999,
            padding: '4px 12px', fontSize: 11, fontFamily: 'var(--font-mono)', cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', gap: 5, zIndex: 2,
          }}
        >
          ↓ {newCount} new
        </button>
      )}
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────
   Trigger row
───────────────────────────────────────────────────────────── */
function TriggerRow({ label, unit, value, onChange, min, max }: {
  label: string; unit: string; value: number | null;
  onChange: (v: number | null) => void; min: number; max: number;
}) {
  const enabled = value !== null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
      <input type="checkbox" checked={enabled} className="accent-[color:var(--accent)]"
        style={{ width: 12, height: 12, flexShrink: 0 }}
        onChange={(e) => onChange(e.target.checked ? (min > 0 ? min : Math.abs(min)) : null)} />
      <span className="text-[11px] flex-1">{label}</span>
      {enabled ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input className="input font-mono" type="number" inputMode="decimal" min={min} max={max}
            value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
            style={{ width: 60, height: 26, fontSize: 11 }} />
          <span className="text-[10px]" style={{ color: 'var(--text-3)', minWidth: 18 }}>{unit}</span>
        </div>
      ) : (
        <span className="font-mono text-[10px]" style={{ color: 'var(--text-3)' }}>—</span>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Toggle
───────────────────────────────────────────────────────────── */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className="flex items-center gap-2 btn btn-ghost btn-sm">
      <span style={{
        display: 'inline-flex', width: 32, height: 18, borderRadius: 999, alignItems: 'center', padding: '0 3px',
        background: checked ? 'var(--ok)' : 'var(--surface-2)', border: '1px solid var(--border-2)',
        transition: 'background 200ms', position: 'relative',
      }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#fff', position: 'absolute', left: checked ? 15 : 3, transition: 'left 200ms' }} />
      </span>
      {label && <span className="text-[12px]">{label}</span>}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────
   History panel + trade detail drawer
───────────────────────────────────────────────────────────── */

function formatSnipeTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
  const daysAgo = Math.floor((startOfToday.getTime() - d.getTime()) / 86_400_000);

  if (d >= startOfToday) return `Today ${timeStr}`;
  if (d >= startOfYesterday) return `Yesterday ${timeStr}`;
  if (daysAgo <= 6) return `${daysAgo}d ago ${timeStr}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + timeStr;
}

function HistoryPanel({ trades, loading, headerRight }: { trades: SnipeTrade[]; loading: boolean; headerRight?: React.ReactNode }) {
  const [sellingId, setSellingId] = useState<string | null>(null);
  const [selected, setSelected]  = useState<SnipeTrade | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const manualSell = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSellingId(id);
    try {
      await api.post(`/snipe/history/${id}/sell`, {});
      invalidate('/snipe/history?limit=50');
    } catch { /* WS events handle status updates */ } finally { setSellingId(null); }
  };

  useEffect(() => {
    if (!selected) return;
    const fresh = trades.find((t) => t.id === selected.id);
    if (fresh) setSelected(fresh);
  }, [trades]);

  // Group trades by intel source (groupId), preserve insertion order
  const groups: { groupId: string; trades: SnipeTrade[] }[] = [];
  const seen = new Map<string, SnipeTrade[]>();
  for (const t of trades) {
    if (!seen.has(t.groupId)) {
      seen.set(t.groupId, []);
      groups.push({ groupId: t.groupId, trades: seen.get(t.groupId)! });
    }
    seen.get(t.groupId)!.push(t);
  }

  const toggleCollapse = (gid: string) =>
    setCollapsed((prev) => { const s = new Set(prev); s.has(gid) ? s.delete(gid) : s.add(gid); return s; });

  const confirmedTotal = trades.filter((t) => t.status === 'confirmed').length;
  const failedTotal   = trades.filter((t) => t.status === 'failed').length;

  return (
    <div className="panel" style={{ padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Header with live stats */}
      <div style={{ padding: '7px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, flex: 1, color: 'var(--text)' }}>Trades</span>
        {trades.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {confirmedTotal > 0 && <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--ok)' }}>{confirmedTotal}✓</span>}
            {failedTotal   > 0 && <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--bad)' }}>{failedTotal}✗</span>}
            <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>{trades.length}tx</span>
          </div>
        )}
        {headerRight}
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[...Array(4)].map((_, i) => <Skeleton key={i} h={28} rounded="md" />)}
            </div>
          ) : trades.length === 0 ? (
            <div style={{ padding: '32px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: 28, opacity: 0.2, marginBottom: 8 }}>⚡</div>
              <p className="text-[12px]" style={{ color: 'var(--text-3)' }}>No trades yet</p>
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-3)', opacity: 0.7 }}>Snipes will appear here in real-time</p>
            </div>
          ) : (
            <>
              {groups.map(({ groupId, trades: groupTrades }) => {
                const isCollapsed = collapsed.has(groupId);
                const confirmedCount = groupTrades.filter((t) => t.status === 'confirmed').length;
                const failedCount = groupTrades.filter((t) => t.status === 'failed').length;
                const color = groupInitialColor(groupId);
                const label = groupId.length > 14 ? `${groupId.slice(0, 7)}…${groupId.slice(-4)}` : groupId;

                return (
                  <div key={groupId}>
                    {/* Group header — sticky */}
                    <button
                      onClick={() => toggleCollapse(groupId)}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                        padding: '5px 12px',
                        background: `color-mix(in srgb, ${color} 5%, var(--surface-2))`,
                        borderTop: '1px solid var(--border)',
                        borderBottom: '1px solid var(--border)',
                        cursor: 'pointer', textAlign: 'left',
                        position: 'sticky', top: 0, zIndex: 2,
                      }}
                    >
                      <span style={{
                        width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                        background: `color-mix(in srgb, ${color} 25%, var(--surface))`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 8, fontWeight: 800, color,
                      }}>{label.slice(0, 1).toUpperCase()}</span>
                      <span className="font-mono text-[10px] flex-1 truncate" style={{ color: 'var(--text-2)' }}>
                        {label}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                        {confirmedCount > 0 && <span className="font-mono text-[9px] font-bold" style={{ color: 'var(--ok)' }}>{confirmedCount}✓</span>}
                        {failedCount > 0   && <span className="font-mono text-[9px] font-bold" style={{ color: 'var(--bad)' }}>{failedCount}✗</span>}
                        <span className="font-mono text-[9px]" style={{ color: 'var(--text-3)' }}>{groupTrades.length}tx</span>
                        <span style={{ color: 'var(--text-3)', fontSize: 9 }}>{isCollapsed ? '▸' : '▾'}</span>
                      </div>
                    </button>

                    {/* Trade rows */}
                    {!isCollapsed && groupTrades.map((t) => {
                      const ok = t.status === 'confirmed';
                      const broadcasting = t.status === 'broadcast';
                      const sol = (Number(t.amountRaw) / 1e9).toFixed(3);
                      // Allow sell if no sell yet, or if previous sell failed (retry)
                      const canSell = (t.status === 'broadcast' || t.status === 'confirmed')
                        && (!t.sellStatus || t.sellStatus === 'failed');
                      const isActive = selected?.id === t.id;
                      const attempts = t.attempts ?? 1;

                      const statusColor = ok ? 'var(--ok)'
                        : t.status === 'failed' ? 'var(--bad)'
                        : broadcasting ? 'var(--warn)'
                        : 'var(--text-3)';

                      const sellStatusColor = t.sellStatus === 'confirmed' ? '#a855f7'
                        : t.sellStatus === 'broadcast' || t.sellStatus === 'pending' ? '#f97316'
                        : t.sellStatus === 'failed' ? 'var(--bad)'
                        : 'var(--text-3)';
                      const sellStatusLabel = t.sellStatus === 'confirmed' ? 'SOLD'
                        : t.sellStatus === 'broadcast' ? 'SELLING'
                        : t.sellStatus === 'pending' ? 'SELLING'
                        : t.sellStatus === 'failed' ? 'SELL FAIL'
                        : t.sellStatus === 'skip' ? 'SKIPPED'
                        : null;

                      return (
                        <div
                          key={t.id}
                          onClick={() => setSelected(isActive ? null : t)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '6px 12px',
                            borderBottom: '1px solid var(--border)',
                            cursor: 'pointer',
                            background: isActive
                              ? 'color-mix(in srgb, var(--accent) 8%, transparent)'
                              : 'transparent',
                            borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                            transition: 'background 80ms',
                          }}
                        >
                          {/* Status indicator dot */}
                          <span style={{
                            width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                            background: statusColor,
                            boxShadow: ok ? `0 0 4px ${statusColor}` : undefined,
                          }} />

                          {/* Token CA */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="font-mono text-[11px]" style={{ color: 'var(--text)' }}>
                              {t.mint.slice(0, 6)}…{t.mint.slice(-4)}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 1, flexWrap: 'wrap' }}>
                              <span className="font-mono text-[10px]" style={{ color: 'var(--text-3)' }}>{sol} SOL</span>
                              {attempts > 1 && (
                                <span className="font-mono text-[9px]" style={{ color: 'var(--warn)' }} title={`${attempts} retries`}>
                                  ×{attempts}
                                </span>
                              )}
                              {sellStatusLabel && (
                                <span className="font-mono text-[9px] font-bold" style={{ color: sellStatusColor }}>
                                  {sellStatusLabel}
                                </span>
                              )}
                              {t.sellTxHash && t.sellStatus !== 'failed' && (
                                <a
                                  href={`https://solscan.io/tx/${t.sellTxHash}`}
                                  target="_blank" rel="noopener"
                                  onClick={(e) => e.stopPropagation()}
                                  className="font-mono text-[9px]"
                                  style={{ color: sellStatusColor, textDecoration: 'none' }}
                                >
                                  {t.sellTxHash.slice(0, 4)}…↗
                                </a>
                              )}
                            </div>
                          </div>

                          {/* Buy status + Tx */}
                          <div style={{ textAlign: 'right', flexShrink: 0 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: statusColor }}>
                              {t.status === 'confirmed' ? 'FILLED' : t.status === 'broadcast' ? 'PENDING' : t.status === 'failed' ? 'FAILED' : t.status.toUpperCase()}
                            </div>
                            {t.txHash && (
                              <a
                                href={`https://solscan.io/tx/${t.txHash}`} target="_blank" rel="noopener"
                                onClick={(e) => e.stopPropagation()}
                                className="font-mono text-[9px]" style={{ color: 'var(--accent)' }}>
                                {t.txHash.slice(0, 4)}…↗
                              </a>
                            )}
                          </div>

                          {/* Time */}
                          <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 38 }}>
                            <div className="font-mono text-[10px]" style={{ color: 'var(--text-3)' }}>
                              {new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>
                          </div>

                          {/* Sell button — shows for unsold or failed-sell trades */}
                          {canSell && (
                            <div onClick={(e) => e.stopPropagation()}>
                              <button
                                className="btn btn-ghost btn-sm"
                                style={{
                                  fontSize: 10, height: 22, padding: '0 7px',
                                  color: t.sellStatus === 'failed' ? 'var(--bad)' : undefined,
                                  borderColor: t.sellStatus === 'failed' ? 'color-mix(in srgb, var(--bad) 35%, transparent)' : undefined,
                                }}
                                onClick={(e) => manualSell(t.id, e)}
                                disabled={sellingId === t.id || t.sellStatus === 'broadcast' || t.sellStatus === 'pending'}>
                                {sellingId === t.id ? <Spinner size={9} /> : t.sellStatus === 'failed' ? 'retry' : 'sell'}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </>
          )}
        </div>

        {selected && typeof document !== 'undefined' &&
          createPortal(
            <TradeModal trade={selected} onClose={() => setSelected(null)} />,
            document.body
          )
        }
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Trade detail modal (portal — no layout distortion)
───────────────────────────────────────────────────────────── */
function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7, padding: '8px 10px' }}>
      <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 600, color: color ?? 'var(--text)' }}>{value}</div>
    </div>
  );
}

function TradeModal({ trade, onClose }: { trade: SnipeTrade; onClose: () => void }) {
  const sol    = (Number(trade.amountRaw) / 1e9).toFixed(4);
  const outSol = trade.outAmount ? (Number(trade.outAmount) / 1e9).toFixed(4) : null;
  const statusColor =
    trade.status === 'confirmed' ? 'var(--ok)' :
    trade.status === 'failed'    ? 'var(--bad)' : 'var(--warn)';
  const statusLabel =
    trade.status === 'confirmed' ? 'FILLED' :
    trade.status === 'failed'    ? 'FAILED' :
    trade.status === 'broadcast' ? 'PENDING' : trade.status.toUpperCase();
  const attempts = trade.attempts ?? 1;

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border-2)',
          borderRadius: 14,
          width: '100%', maxWidth: 460,
          maxHeight: '88vh', overflowY: 'auto',
          boxShadow: '0 32px 80px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.04)',
          animation: 'qwai-fade-in 150ms ease-out both',
          overscrollBehavior: 'contain',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 14px', borderBottom: '1px solid var(--border)',
          position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1,
          borderRadius: '14px 14px 0 0',
        }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0, boxShadow: `0 0 6px ${statusColor}` }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: statusColor, letterSpacing: '0.04em' }}>{statusLabel}</div>
            <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', marginTop: 1 }}>
              {new Date(trade.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 26, height: 26, borderRadius: 7, flexShrink: 0,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', fontSize: 16, color: 'var(--text-2)', lineHeight: 1,
            }}
          >×</button>
        </div>

        <div style={{ padding: '14px 14px 18px' }}>
          {/* Token CA */}
          <div style={{
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '9px 12px', marginBottom: 12,
            display: 'flex', alignItems: 'flex-start', gap: 8,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.1em', marginBottom: 4, textTransform: 'uppercase' }}>Token</div>
              <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text)', wordBreak: 'break-all', lineHeight: 1.5 }}>{trade.mint}</div>
            </div>
            <a
              href={`https://solscan.io/token/${trade.mint}`}
              target="_blank" rel="noopener"
              style={{ fontSize: 10, color: 'var(--accent)', fontFamily: 'var(--font-mono)', flexShrink: 0, marginTop: 18 }}
              onClick={(e) => e.stopPropagation()}
            >view ↗</a>
          </div>

          {/* Stats grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <StatCell label="Buy size" value={`${sol} SOL`} />
            {outSol && Number(outSol) > 0
              ? <StatCell label="Received" value={outSol} />
              : <StatCell label="Chain" value={trade.chain} />
            }
            <StatCell label="Retries" value={`×${attempts}`} color={attempts > 1 ? 'var(--warn)' : undefined} />
            <StatCell label="Source" value={trade.groupId.length > 14 ? `${trade.groupId.slice(0, 10)}…` : trade.groupId} />
          </div>

          {/* TX hash */}
          {trade.txHash && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 5 }}>Transaction</div>
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text)', flex: 1, wordBreak: 'break-all' }}>{trade.txHash}</span>
                <a href={`https://solscan.io/tx/${trade.txHash}`} target="_blank" rel="noopener"
                  style={{ fontSize: 10, color: 'var(--accent)', flexShrink: 0, fontFamily: 'var(--font-mono)' }}
                  onClick={(e) => e.stopPropagation()}>
                  ↗
                </a>
              </div>
            </div>
          )}

          {/* Failure reason */}
          {trade.errorMsg && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--bad)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 5 }}>Failure reason</div>
              <div style={{
                background: 'color-mix(in srgb, var(--bad) 8%, var(--surface-2))',
                border: '1px solid color-mix(in srgb, var(--bad) 22%, transparent)',
                borderRadius: 7, padding: '8px 10px',
                fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--bad)', lineHeight: 1.5, wordBreak: 'break-word',
              }}>
                {trade.errorMsg}
              </div>
            </div>
          )}

          {/* Source message */}
          {trade.sourceMsg && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 5 }}>Source message</div>
              <div style={{
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                borderRadius: 7, padding: '8px 10px',
                fontSize: 11, color: 'var(--text-2)', lineHeight: 1.6,
                maxHeight: 90, overflowY: 'auto',
              }}>
                {trade.sourceMsg}
              </div>
            </div>
          )}

          {/* Sell info */}
          {trade.sellStatus && (
            <div>
              <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>Exit</div>

              {/* Status + reason row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
                  padding: '3px 7px', borderRadius: 5,
                  color: trade.sellStatus === 'confirmed' ? '#a855f7'
                    : trade.sellStatus === 'failed' ? 'var(--bad)'
                    : '#f97316',
                  background: trade.sellStatus === 'confirmed' ? 'color-mix(in srgb, #a855f7 14%, transparent)'
                    : trade.sellStatus === 'failed' ? 'color-mix(in srgb, var(--bad) 12%, transparent)'
                    : 'color-mix(in srgb, #f97316 14%, transparent)',
                  border: `1px solid ${trade.sellStatus === 'confirmed' ? 'color-mix(in srgb, #a855f7 35%, transparent)'
                    : trade.sellStatus === 'failed' ? 'color-mix(in srgb, var(--bad) 25%, transparent)'
                    : 'color-mix(in srgb, #f97316 35%, transparent)'}`,
                }}>
                  {trade.sellStatus === 'confirmed' ? 'SOLD' : trade.sellStatus === 'broadcast' ? 'SELLING' : trade.sellStatus === 'failed' ? 'FAILED' : trade.sellStatus.toUpperCase()}
                </span>
                {trade.sellReason && (
                  <span style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'capitalize' }}>
                    {trade.sellReason.replace(/_/g, ' ')}
                  </span>
                )}
              </div>

              {/* Sell tx hash — full, clickable */}
              {trade.sellTxHash && (
                <div style={{
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  borderRadius: 7, padding: '8px 10px',
                  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
                }}>
                  <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text)', flex: 1, wordBreak: 'break-all', lineHeight: 1.5 }}>
                    {trade.sellTxHash}
                  </span>
                  <a
                    href={`https://solscan.io/tx/${trade.sellTxHash}`}
                    target="_blank" rel="noopener"
                    style={{ fontSize: 11, color: '#a855f7', flexShrink: 0, fontFamily: 'var(--font-mono)' }}
                    onClick={(e) => e.stopPropagation()}
                  >↗</a>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Page skeleton
───────────────────────────────────────────────────────────── */
function PageSkeleton() {
  return (
    <div className="page page-wide" style={{ paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Skeleton w={120} h={20} />
        <div style={{ flex: 1 }} />
        <Skeleton w={180} h={22} rounded="md" />
      </div>
      <div className="snipe-3col">
        <div className="snipe-col-setup space-y-3">
          <div className="panel space-y-3">{[...Array(3)].map((_, i) => <Skeleton key={i} h={36} rounded="md" />)}</div>
          <div className="panel space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} h={32} rounded="md" />)}</div>
        </div>
        <div className="snipe-col-inbox">
          <div className="panel" style={{ flex: 1, minHeight: 500, padding: 0 }}><Skeleton h="100%" /></div>
        </div>
        <div className="snipe-col-history">
          <div className="panel" style={{ flex: 1, minHeight: 500, padding: 0 }}><Skeleton h="100%" /></div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Icons
───────────────────────────────────────────────────────────── */
function Svg({ size = 18, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}
function IcoSnipe({ size }: { size?: number }) {
  return <Svg size={size}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></Svg>;
}
function IcoTelegram({ size }: { size?: number }) {
  return <Svg size={size}><path d="M21.5 4.5L2.5 11l7.5 2.5 2.5 7.5 3.5-5.5 5.5 3.5-1.5-14.5z" /></Svg>;
}
function IcoQr({ size }: { size?: number }) {
  return (
    <svg width={size ?? 16} height={size ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h2v2h-2zM18 14h3v2h-3zM14 18h2v3h-2zM18 18h3v3h-3z" />
    </svg>
  );
}

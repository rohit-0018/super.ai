'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import QRCode from 'react-qr-code';
import { useApi, invalidate, mutate } from '../../lib/useApi';
import { useRealtime } from '../../lib/useRealtime';
import { api } from '../../lib/api';
import { Skeleton, Spinner } from '../../components/ui/Skeleton';

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

  const [banner, setBanner] = useState<SnipeBannerData | null>(null);
  const bannerKeyRef = useRef(0);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useRealtime('snipe_triggered', useCallback((evt: any) => {
    invalidate('/snipe/history?limit=50');
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    bannerKeyRef.current += 1;
    setBanner({ status: evt.status, mint: evt.mint, durationMs: evt.durationMs, txHash: evt.txHash, error: evt.error, key: bannerKeyRef.current });
    bannerTimer.current = setTimeout(() => setBanner(null), 3300);
  }, []));

  useRealtime('snipe_sold', useCallback(() => {
    invalidate('/snipe/history?limit=50');
  }, []));

  // Background confirmation updates (no banner — just refresh history silently)
  useRealtime('snipe_update', useCallback(() => {
    invalidate('/snipe/history?limit=50');
  }, []));

  const config  = configData?.config ?? null;
  const session = configData?.session ?? { active: false };

  if (configLoading || tgLoading) return <PageSkeleton />;

  return (
    <div className="page page-wide space-y-4">
      {banner && <SnipeBanner key={banner.key} banner={banner} onDismiss={() => setBanner(null)} />}
      <header className="page-header">
        <div>
          <div className="section-eyebrow">Agents</div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <IcoSnipe size={20} />
            Sniper
          </h1>
          <p className="page-subtitle">
            CA detected in your Telegram groups → buy broadcast in &lt;500 ms.
          </p>
        </div>
        <StatusBar tg={tgStatus} session={session} config={config} />
      </header>

      <SnipeStatusNotice config={config} tgConnected={!!tgStatus?.connected} />

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4" style={{ alignItems: 'start' }}>
        <div className="xl:col-span-2 space-y-4">
          <TgPanel status={tgStatus} />
          <ConfigPanel config={config} wallets={wallets ?? []} />
        </div>

        <div className="xl:col-span-3 space-y-4">
          <TgInboxPanel config={config} tgConnected={!!tgStatus?.connected} session={session as any} />
          <HistoryPanel trades={history ?? []} loading={histLoading} />
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Snipe banner — appears for 3 s on every snipe attempt
───────────────────────────────────────────────────────────── */
function SnipeBanner({ banner, onDismiss }: { banner: SnipeBannerData; onDismiss: () => void }) {
  const ok = banner.status !== 'failed';
  const color = ok ? 'var(--ok)' : 'var(--bad)';
  return (
    <div
      className="snap-banner"
      onClick={onDismiss}
      style={{
        cursor: 'pointer',
        background: `color-mix(in srgb, ${color} 12%, var(--surface))`,
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
        boxShadow: `inset 0 1px 0 var(--highlight), 0 2px 12px rgba(0,0,0,0.3)`,
        borderRadius: 10,
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <span style={{ fontSize: 20, lineHeight: 1 }}>{ok ? '⚡' : '✗'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="text-[13px] font-semibold" style={{ color }}>
          {ok ? `Sniped! · ${banner.durationMs}ms` : `Snipe failed · ${banner.durationMs}ms`}
        </div>
        <div className="font-mono text-[11px] truncate" style={{ color: 'var(--text-2)', marginTop: 1 }}>
          {banner.mint.slice(0, 8)}…{banner.mint.slice(-4)}
          {banner.error && <span style={{ color: 'var(--text-3)' }}> · {banner.error.slice(0, 80)}</span>}
        </div>
      </div>
      {banner.txHash && (
        <a
          href={`https://solscan.io/tx/${banner.txHash}`}
          target="_blank" rel="noopener"
          className="font-mono text-[11px]"
          style={{ color: 'var(--accent)', flexShrink: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          {banner.txHash.slice(0, 8)}…
        </a>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Setup / activation notice
───────────────────────────────────────────────────────────── */
function SnipeStatusNotice({ config, tgConnected }: { config: SnipeConfig | null; tgConnected: boolean }) {
  const base: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '9px 14px', borderRadius: 10, fontSize: 12,
    border: '1px solid',
  };
  const info: React.CSSProperties = {
    ...base,
    background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))',
    borderColor: 'color-mix(in srgb, var(--accent) 25%, transparent)',
    color: 'var(--text-2)',
  };
  const warn: React.CSSProperties = {
    ...base,
    background: 'color-mix(in srgb, var(--warn) 10%, var(--surface))',
    borderColor: 'color-mix(in srgb, var(--warn) 30%, transparent)',
    color: 'var(--warn)',
  };

  if (!config) return (
    <div style={info}>
      <span style={{ fontSize: 16, flexShrink: 0 }}>⚡</span>
      <span>
        <strong>Sniper not set up yet.</strong> Pick a wallet in <em>Snipe settings</em>, connect Telegram, track at least one group, then flip the toggle to <strong>On</strong>.
      </span>
    </div>
  );

  if (!config.enabled) return (
    <div style={warn}>
      <span style={{ fontSize: 16, flexShrink: 0 }}>⚠</span>
      <span>
        <strong>Sniper is OFF — no trades will trigger.</strong> Configure your settings below, then flip the <strong>On / Off</strong> toggle in <em>Snipe settings</em> when you're ready.
      </span>
    </div>
  );

  if (config.groupIds.length === 0) return (
    <div style={warn}>
      <span style={{ fontSize: 16, flexShrink: 0 }}>⚠</span>
      <span>
        <strong>No groups being watched.</strong> Sniper is on but has nothing to listen to — open the inbox, select a group and click <strong>+ Watch</strong>.
      </span>
    </div>
  );

  if (!tgConnected) return (
    <div style={warn}>
      <span style={{ fontSize: 16, flexShrink: 0 }}>⚠</span>
      <span>
        <strong>Telegram not connected.</strong> Sniper is on and groups are tracked, but no live feed — connect your account in the <em>Telegram account</em> panel.
      </span>
    </div>
  );

  return null;
}

/* ─────────────────────────────────────────────────────────────
   Status bar
───────────────────────────────────────────────────────────── */
function StatusBar({ tg, session, config }: {
  tg: TgStatus | null;
  session: { active: boolean; address?: string; balanceLamports?: number };
  config: SnipeConfig | null;
}) {
  const solBalance = session.balanceLamports !== undefined ? session.balanceLamports / 1e9 : null;
  const lowBalance = solBalance !== null && solBalance < 0.005;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2 flex-wrap justify-end">
        {tg?.connected
          ? <span className="chip chip-ok">TG Live</span>
          : <span className="chip chip-bad">TG offline</span>}
        {session.active
          ? <span className="chip chip-ok">Hot session</span>
          : <span className="chip">No hot session</span>}
        {config?.enabled
          ? <span className="chip chip-accent" style={{ fontWeight: 600 }}>● Sniper ON</span>
          : <span className="chip">Sniper OFF</span>}
        {config?.enabled && config.groupIds.length > 0 && (
          <span className="chip" style={{ color: 'var(--text-2)' }}>{config.groupIds.length} watching</span>
        )}
      </div>
      {session.active && solBalance !== null && (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[11px]" style={{ color: lowBalance ? 'var(--warn)' : 'var(--text-3)' }}>
            {solBalance.toFixed(4)} SOL
          </span>
          {lowBalance && (
            <span className="chip chip-warn" style={{ fontSize: 10 }}>
              Low balance — fund wallet or trades will drop
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Telegram auth panel
───────────────────────────────────────────────────────────── */
type QrStep = 'idle' | 'qr' | '2fa';

function TgPanel({ status }: { status: TgStatus | null }) {
  const connected = status?.connected ?? false;
  const [step, setStep] = useState<QrStep>('idle');
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [pw, setPw]       = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { if (connected) { stopPoll(); setStep('idle'); setQrUrl(null); } }, [connected]);
  useEffect(() => () => stopPoll(), []);

  function stopPoll() { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } }

  function startPoll() {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await api.get<{ status: string; qrUrl?: string; error?: string }>('/snipe/tg/qr/poll');
        if (data.qrUrl) setQrUrl(data.qrUrl);
        if (data.status === 'success') { stopPoll(); setStep('idle'); setQrUrl(null); mutate<TgStatus>('/snipe/tg/status', () => ({ connected: true, me: null, qrPending: false })); invalidate('/snipe/tg/status'); }
        else if (data.status === 'needs_2fa') { stopPoll(); setStep('2fa'); }
        else if (data.status === 'error') { stopPoll(); setErr(data.error ?? 'Login failed'); setStep('idle'); setQrUrl(null); }
      } catch {}
    }, 2500);
  }

  const startQr = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/snipe/tg/qr/start', {});
      const { data } = await api.get<{ status: string; qrUrl?: string }>('/snipe/tg/qr/poll');
      setQrUrl(data.qrUrl ?? null); setStep('qr'); startPoll();
    } catch (e: any) { setErr(e?.message ?? 'Failed to start QR login'); }
    finally { setBusy(false); }
  };

  const submit2fa = async () => {
    setBusy(true); setErr(null);
    try { await api.post('/snipe/tg/qr/verify-2fa', { password: pw }); startPoll(); setStep('qr'); }
    catch (e: any) { setErr(e?.message ?? 'Wrong password'); }
    finally { setBusy(false); }
  };

  const cancel = async () => { stopPoll(); await api.delete('/snipe/tg/qr/cancel').catch(() => {}); setStep('idle'); setQrUrl(null); setErr(null); };

  const disconnect = async () => {
    setBusy(true);
    try { await api.delete('/snipe/tg/session'); invalidate('/snipe/tg/status'); }
    catch (e: any) { setErr(e?.message ?? 'Error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="panel space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <IcoTelegram size={15} />
          <h2 className="section-title" style={{ margin: 0 }}>Telegram account</h2>
        </div>
        {connected && <span className="live-dot" />}
      </div>

      {connected ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3" style={{ padding: '8px 10px', background: 'var(--bg-2)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div className="flex items-center justify-center rounded-full font-semibold text-[13px]"
              style={{ width: 34, height: 34, background: 'color-mix(in srgb, var(--accent) 18%, transparent)', color: 'var(--accent)', flexShrink: 0 }}>
              {status?.me?.firstName?.[0]?.toUpperCase() ?? '?'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold truncate">{status?.me?.firstName}</div>
              <div className="text-[11px] font-mono truncate" style={{ color: 'var(--text-3)' }}>
                {status?.me?.username ? `@${status.me.username}` : status?.me?.phone}
              </div>
            </div>
            <span className="chip chip-ok" style={{ fontSize: 10 }}>Live</span>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={disconnect} disabled={busy}
            style={{ color: 'var(--bad)', borderColor: 'color-mix(in srgb, var(--bad) 30%, transparent)' }}>
            {busy ? <Spinner size={11} /> : 'Disconnect'}
          </button>
        </div>
      ) : step === 'idle' ? (
        <div className="space-y-3">
          <p className="text-[12px]" style={{ color: 'var(--text-2)' }}>
            Connect your personal account to monitor every group in real-time.
          </p>
          {err && <p className="text-[12px]" style={{ color: 'var(--bad)' }}>{err}</p>}
          <button className="btn btn-primary" onClick={startQr} disabled={busy}>
            {busy ? <Spinner size={12} /> : <><IcoQr size={13} /> Scan QR code</>}
          </button>
        </div>
      ) : step === 'qr' ? (
        <div className="space-y-4">
          <p className="text-[12px]" style={{ color: 'var(--text-2)' }}>
            Open Telegram → Settings → Devices → Scan QR code
          </p>
          {qrUrl
            ? <div className="flex justify-center"><div style={{ background: '#fff', padding: 10, borderRadius: 10, border: '1px solid var(--border)' }}><QRCode value={qrUrl} size={160} /></div></div>
            : <div className="flex justify-center py-4"><Spinner size={20} /></div>}
          <div className="flex items-center gap-2 justify-center text-[11px]" style={{ color: 'var(--text-3)' }}>
            <Spinner size={10} /><span>Waiting for scan…</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={cancel}>Cancel</button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[12px]" style={{ color: 'var(--text-2)' }}>Two-step verification — enter your cloud password.</p>
          <input className="input" type="password" placeholder="Cloud password"
            value={pw} onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit2fa()} />
          {err && <p className="text-[12px]" style={{ color: 'var(--bad)' }}>{err}</p>}
          <div className="flex gap-2">
            <button className="btn btn-ghost btn-sm" onClick={cancel} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={submit2fa} disabled={busy || !pw}>
              {busy ? <Spinner size={12} /> : 'Confirm →'}
            </button>
          </div>
        </div>
      )}
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
function toSnipeDto(c: SnipeConfig) {
  return {
    enabled: c.enabled, chain: c.chain, walletId: c.walletId,
    buyAmountRaw: c.buyAmountRaw, maxSlippageBps: c.maxSlippageBps,
    groupIds: c.groupIds, skipSafety: c.skipSafety, dedupeWindowMs: c.dedupeWindowMs,
    notifyOnBuy: c.notifyOnBuy, matchPattern: c.matchPattern,
    sellEnabled: c.sellEnabled, sellMode: c.sellMode,
    takeProfitPct: c.takeProfitPct, stopLossPct: c.stopLossPct,
    trailingStopPct: c.trailingStopPct, exitAfterMs: c.exitAfterMs, partialExitPct: c.partialExitPct,
  };
}

function ConfigPanel({ config, wallets }: { config: SnipeConfig | null; wallets: Wallet[] }) {
  const [form, setForm] = useState<SnipeConfig>({
    enabled: false, chain: 'SOLANA', walletId: '', buyAmountRaw: '100000000',
    maxSlippageBps: 5000, groupIds: [], skipSafety: true, dedupeWindowMs: 30000,
    notifyOnBuy: true, matchPattern: null, sellEnabled: true, sellMode: 'TRIGGER',
    takeProfitPct: null, stopLossPct: null, trailingStopPct: null, exitAfterMs: null, partialExitPct: null,
  });
  const [tab, setTab]       = useState<'buy' | 'sell'>('buy');
  const [busy, setBusy]     = useState(false);
  const [hotBusy, setHotBusy] = useState(false);
  const [msg, setMsg]       = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (config) setForm((f) => ({
      ...f, ...config,
      // Never let a server-side empty walletId overwrite a user selection
      walletId: config.walletId || f.walletId,
    }));
  }, [config]);

  const set = <K extends keyof SnipeConfig>(k: K, v: SnipeConfig[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true); setMsg(null);
    try { await api.put('/snipe/config', toSnipeDto(form)); setMsg({ text: 'Saved', ok: true }); invalidate('/snipe/config'); }
    catch (e: any) { setMsg({ text: e?.message ?? 'Failed', ok: false }); }
    finally { setBusy(false); }
  };

  const loadSession = async () => {
    if (!form.walletId) return;
    setHotBusy(true); setMsg(null);
    try { await api.post('/snipe/session/start', { walletId: form.walletId }); setMsg({ text: 'Hot session started', ok: true }); invalidate('/snipe/config'); }
    catch (e: any) { setMsg({ text: e?.message ?? 'Failed', ok: false }); }
    finally { setHotBusy(false); }
  };

  const applyStrategy = (s: typeof SELL_STRATEGIES[number]) =>
    setForm((f) => ({ ...f, takeProfitPct: s.tp, stopLossPct: s.sl, trailingStopPct: s.trail ?? null, exitAfterMs: s.exit ?? null }));

  const solAmount = (Number(form.buyAmountRaw) / 1e9).toFixed(4);
  const filteredWallets = wallets.filter((w) => w.chain === form.chain);

  return (
    <div className="panel space-y-0" style={{ padding: 0 }}>
      <div className="flex items-center" style={{ borderBottom: '1px solid var(--border)', padding: '10px 14px 0' }}>
        <h2 className="section-title" style={{ margin: '0 12px 0 0' }}>Snipe settings</h2>
        <div className="flex gap-1 flex-1">
          {(['buy', 'sell'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`btn btn-sm ${tab === t ? 'btn-primary' : 'btn-ghost'}`}
              style={{ borderRadius: '6px 6px 0 0', borderBottom: tab === t ? '2px solid var(--accent-2)' : '2px solid transparent' }}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} label={form.enabled ? 'On' : 'Off'} />
          <button className="btn btn-primary btn-sm" onClick={save} disabled={busy || !form.walletId}>
            {busy ? <Spinner size={11} /> : 'Save'}
          </button>
        </div>
      </div>

      <div style={{ padding: '14px' }}>
        {tab === 'buy' && (
          <div className="space-y-4">
            <div>
              <label className="label">Chain</label>
              <div className="flex gap-1.5">
                {(['SOLANA', 'EVM'] as const).map((c) => (
                  <button key={c} onClick={() => set('chain', c)}
                    className={`btn btn-sm ${form.chain === c ? 'btn-primary' : 'btn-ghost'}`}>{c}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Signing wallet</label>
              <select className="input" value={form.walletId} onChange={(e) => set('walletId', e.target.value)}>
                <option value="">Select wallet…</option>
                {filteredWallets.map((w) => (
                  <option key={w.id} value={w.id}>{w.label ?? `${w.address.slice(0, 8)}…${w.address.slice(-4)}`}</option>
                ))}
              </select>
            </div>
            {form.walletId && (
              <button className="btn btn-ghost btn-sm" onClick={loadSession} disabled={hotBusy}>
                {hotBusy ? <><Spinner size={11} /> Loading…</> : '🔑 Load hot session'}
              </button>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Buy amount (lamports)</label>
                <input className="input font-mono" value={form.buyAmountRaw} onChange={(e) => set('buyAmountRaw', e.target.value)} />
                <p className="text-[11px] mt-1 font-mono" style={{ color: 'var(--text-3)' }}>≈ {solAmount} SOL</p>
              </div>
              <div>
                <label className="label">Max slippage (bps)</label>
                <input className="input font-mono" type="number" min={100} max={9000}
                  value={form.maxSlippageBps} onChange={(e) => set('maxSlippageBps', +e.target.value)} />
              </div>
            </div>
            <div className="space-y-2.5">
              {[
                { k: 'notifyOnBuy' as const, label: 'Telegram notification on buy' },
                { k: 'skipSafety'  as const, label: 'Skip rug-check (max speed)' },
              ].map(({ k, label }) => (
                <label key={k} className="flex items-center gap-2.5 cursor-pointer">
                  <input type="checkbox" checked={form[k] as boolean} onChange={(e) => set(k, e.target.checked)}
                    className="accent-[color:var(--accent)]" />
                  <span className="text-[13px]">{label}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {tab === 'sell' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium">Auto-sell</div>
                <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>Exit positions automatically</div>
              </div>
              <Toggle checked={form.sellEnabled} onChange={(v) => set('sellEnabled', v)} />
            </div>
            {form.sellEnabled && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {(['TRIGGER', 'INTELLIGENT'] as const).map((m) => (
                    <button key={m} onClick={() => set('sellMode', m)}
                      className={`btn btn-sm ${form.sellMode === m ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ flexDirection: 'column', height: 'auto', padding: '8px 10px', alignItems: 'flex-start' }}>
                      <span className="font-semibold text-[12px]">{m}</span>
                      <span className="text-[10px] font-normal" style={{ color: form.sellMode === m ? 'rgba(255,255,255,0.7)' : 'var(--text-3)' }}>
                        {m === 'TRIGGER' ? 'Instant on trigger' : 'AI reviews first'}
                      </span>
                    </button>
                  ))}
                </div>
                <div>
                  <label className="label">Quick strategy</label>
                  <div className="flex gap-1.5">
                    {SELL_STRATEGIES.map((s) => (
                      <button key={s.label} className="btn btn-ghost btn-sm" onClick={() => applyStrategy(s)} style={{ fontSize: 11 }}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-0">
                  <TriggerRow label="Take profit" unit="%" value={form.takeProfitPct} onChange={(v) => set('takeProfitPct', v)} min={1} max={10000} />
                  <TriggerRow label="Stop loss" unit="%" value={form.stopLossPct} onChange={(v) => set('stopLossPct', v)} min={-99} max={-1} />
                  <TriggerRow label="Trailing stop" unit="%" value={form.trailingStopPct} onChange={(v) => set('trailingStopPct', v)} min={1} max={99} />
                  <TriggerRow label="Time exit" unit="min"
                    value={form.exitAfterMs !== null && form.exitAfterMs !== undefined ? form.exitAfterMs / 60_000 : null}
                    onChange={(v) => set('exitAfterMs', v !== null ? Math.round(v * 60_000) : null)}
                    min={1} max={1440} />
                </div>
              </>
            )}
          </div>
        )}
        {msg && <p className="text-[12px] mt-3" style={{ color: msg.ok ? 'var(--ok)' : 'var(--bad)' }}>{msg.text}</p>}
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

function TgInboxPanel({ config, tgConnected, session }: { config: SnipeConfig | null; tgConnected: boolean; session: { active: boolean; balanceLamports?: number } }) {
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
    <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Panel header */}
      <div className="flex items-center justify-between" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2">
          <IcoTelegram size={14} />
          <span className="section-title">Telegram Inbox</span>
          {tgConnected && <span className="live-dot" style={{ marginLeft: 2 }} />}
          {snipeWillRun && <span className="chip chip-ok" style={{ fontSize: 10 }}>● Sniping</span>}
        </div>
        {groups.length > 0 && (
          <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>
            {groups.length} groups · {localGroupIds.length} watching
          </span>
        )}
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
        <div style={{ height: INBOX_HEIGHT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', padding: 24 }}>
            <IcoTelegram size={32} />
            <p className="text-[13px] font-medium mt-3">Connect Telegram to see your groups</p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>Use the panel on the left to scan the QR code.</p>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', height: INBOX_HEIGHT }}>
          {/* ── Left: group list ── */}
          <div style={{ width: 224, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
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

            {/* Group rows */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {groupsLoading ? (
                <div className="space-y-1 p-2">
                  {[...Array(6)].map((_, i) => <Skeleton key={i} h={52} rounded="md" />)}
                </div>
              ) : filtered.length === 0 ? (
                <div style={{ padding: '32px 16px', textAlign: 'center' }}>
                  <p className="text-[12px]" style={{ color: 'var(--text-3)' }}>{search ? 'No match' : 'No groups found'}</p>
                </div>
              ) : filtered.map((g) => {
                const isSelected = selected === g.id;
                const watching   = isWatching(g.id);
                const unreadCnt  = unread.get(g.id) ?? 0;
                const color      = groupInitialColor(g.id);
                return (
                  <button
                    key={g.id}
                    onClick={() => setSelected(g.id)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 9,
                      padding: '8px 10px', textAlign: 'left', cursor: 'pointer',
                      background: isSelected
                        ? 'color-mix(in srgb, var(--accent) 10%, transparent)'
                        : 'transparent',
                      borderLeft: isSelected ? `2px solid var(--accent)` : '2px solid transparent',
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

          {/* ── Right: chat view ── */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
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
            <div className="text-[11px] font-mono" style={{ color: 'var(--text-3)' }}>
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
   Message list — auto-scroll, CA highlighting, live timestamps
───────────────────────────────────────────────────────────── */
function MessageList({ messages, loading, groupId }: { messages: TgMessage[]; loading: boolean; groupId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const prevLenRef = useRef(messages.length);

  // Track new messages when not at bottom
  useEffect(() => {
    const delta = messages.length - prevLenRef.current;
    prevLenRef.current = messages.length;
    if (delta > 0 && !atBottom) setNewCount((n) => n + delta);
  }, [messages.length, atBottom]);

  // Scroll to bottom on new messages if at bottom
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, atBottom]);

  // Reset scroll on group change
  useEffect(() => {
    const el = containerRef.current;
    if (el) { el.scrollTop = el.scrollHeight; setAtBottom(true); setNewCount(0); prevLenRef.current = messages.length; }
  }, [groupId]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAtBottom(isAtBottom);
    if (isAtBottom) setNewCount(0);
  };

  const scrollToBottom = () => {
    const el = containerRef.current;
    if (el) { el.scrollTop = el.scrollHeight; setAtBottom(true); setNewCount(0); }
  };

  if (loading) {
    return (
      <div style={{ flex: 1, padding: 14, overflow: 'hidden' }}>
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} h={i % 2 === 0 ? 40 : 28} rounded="md" />)}
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p className="text-[12px]" style={{ color: 'var(--text-3)' }}>No messages yet — new ones will appear here live.</p>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}
      >
        {messages.map((msg, i) => {
          const prev = messages[i - 1];
          const showTimeSep = !prev || msg.ts - prev.ts > 5 * 60_000;
          const parts = highlightCAs(msg.text);
          const hasCA = parts.some((p) => typeof p !== 'string');
          const timeStr = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

          const showSender = msg.senderName && (!prev || prev.fromId !== msg.fromId || showTimeSep);

          return (
            <div key={msg.id} className="fade-in" style={{ paddingBottom: 1 }}>
              {/* Time separator — shown when >5min gap between messages */}
              {showTimeSep && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px 4px' }}>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                  <span className="text-[10px] font-mono" style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                    {new Date(msg.ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) !== new Date(Date.now()).toLocaleDateString([], { month: 'short', day: 'numeric' })
                      ? new Date(msg.ts).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                      : timeStr}
                  </span>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                </div>
              )}

              {/* Message row */}
              <div
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 0,
                  padding: '3px 14px',
                  background: hasCA ? 'color-mix(in srgb, var(--accent) 5%, transparent)' : 'transparent',
                  borderLeft: hasCA ? '2px solid color-mix(in srgb, var(--accent) 35%, transparent)' : '2px solid transparent',
                  transition: 'background 120ms',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {showSender && (
                    <div className="text-[11px] font-medium" style={{ color: 'var(--accent)', marginBottom: 1 }}>
                      {msg.senderName}
                    </div>
                  )}
                  <div className="text-[13px]" style={{ color: 'var(--text)', lineHeight: 1.55, wordBreak: 'break-word' }}>
                    {parts}
                  </div>
                </div>
                {/* Per-message timestamp (right-aligned, always visible) */}
                <span
                  className="font-mono"
                  style={{ fontSize: 10, color: 'var(--text-3)', flexShrink: 0, marginLeft: 8, marginTop: 3, whiteSpace: 'nowrap' }}
                >
                  {timeStr}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Jump-to-bottom button when new messages arrive off screen */}
      {!atBottom && newCount > 0 && (
        <button
          onClick={scrollToBottom}
          style={{
            position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
            background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 999,
            padding: '4px 12px', fontSize: 11, fontFamily: 'var(--font-mono)', cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', gap: 5,
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
    <div className="flex items-center gap-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
      <input type="checkbox" checked={enabled} className="accent-[color:var(--accent)]"
        onChange={(e) => onChange(e.target.checked ? (min > 0 ? min : Math.abs(min)) : null)} />
      <div className="flex-1 text-[13px]">{label}</div>
      {enabled && (
        <div className="flex items-center gap-1">
          <input className="input font-mono" type="number" min={min} max={max}
            value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
            style={{ width: 80 }} />
          <span className="text-[12px]" style={{ color: 'var(--text-3)' }}>{unit}</span>
        </div>
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
function HistoryPanel({ trades, loading }: { trades: SnipeTrade[]; loading: boolean }) {
  const [sellingId, setSellingId] = useState<string | null>(null);
  const [selected, setSelected]  = useState<SnipeTrade | null>(null);

  const manualSell = async (id: string) => {
    setSellingId(id);
    try { await api.post(`/snipe/history/${id}/sell`, {}); invalidate('/snipe/history?limit=50'); }
    catch {} finally { setSellingId(null); }
  };

  // Keep selected in sync when history refreshes
  useEffect(() => {
    if (!selected) return;
    const fresh = trades.find((t) => t.id === selected.id);
    if (fresh) setSelected(fresh);
  }, [trades]);

  return (
    <div className="panel" style={{ padding: 0 }}>
      <div className="flex items-center justify-between" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <span className="section-title">Snipe history</span>
        <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>Last 50</span>
      </div>

      <div style={{ display: 'flex' }}>
        {/* Trade list */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {loading ? (
            <div className="space-y-2 p-4">{[...Array(3)].map((_, i) => <Skeleton key={i} h={32} rounded="md" />)}</div>
          ) : trades.length === 0 ? (
            <div style={{ padding: '24px 20px', textAlign: 'center' }}>
              <p className="text-[13px]" style={{ color: 'var(--text-3)' }}>No snipe history yet.</p>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead><tr><th>Token</th><th>Tx</th><th>Status</th><th>Sell</th><th className="num">Time</th><th /></tr></thead>
                <tbody>
                  {trades.map((t) => {
                    const ok = t.status !== 'failed';
                    const sol = (Number(t.amountRaw) / 1e9).toFixed(4);
                    const canSell = !t.sellStatus && (t.status === 'broadcast' || t.status === 'confirmed');
                    const isActive = selected?.id === t.id;
                    return (
                      <tr
                        key={t.id}
                        onClick={() => setSelected(isActive ? null : t)}
                        style={{
                          cursor: 'pointer',
                          background: isActive ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : undefined,
                          borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                        }}
                      >
                        <td className="font-mono text-[12px]">{t.mint.slice(0, 8)}…{t.mint.slice(-4)}</td>
                        <td>
                          <div className="flex items-center gap-1.5">
                            {t.txHash
                              ? <a href={`https://solscan.io/tx/${t.txHash}`} target="_blank" rel="noopener"
                                  className="font-mono text-[11px]" style={{ color: 'var(--accent)' }}
                                  onClick={(e) => e.stopPropagation()}>
                                  {t.txHash.slice(0, 6)}…{t.txHash.slice(-4)}
                                </a>
                              : <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>—</span>}
                          </div>
                          <div className="font-mono text-[11px]" style={{ color: 'var(--text-3)' }}>{sol} SOL</div>
                        </td>
                        <td><span className={`chip ${ok ? 'chip-ok' : 'chip-bad'}`} style={{ fontSize: 10 }}>{t.status}</span></td>
                        <td>
                          {t.sellStatus
                            ? <span className="chip" style={{ fontSize: 10 }}>{t.sellStatus}</span>
                            : <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>—</span>}
                        </td>
                        <td className="num font-mono text-[11px]" style={{ color: 'var(--text-3)' }}>
                          {new Date(t.createdAt).toLocaleTimeString()}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {canSell && (
                            <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, height: 24 }}
                              onClick={() => manualSell(t.id)} disabled={sellingId === t.id}>
                              {sellingId === t.id ? <Spinner size={10} /> : 'Sell'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Trade detail panel */}
        {selected && (
          <TradeDetail trade={selected} onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  );
}

function TradeDetail({ trade, onClose }: { trade: SnipeTrade; onClose: () => void }) {
  const ok = trade.status !== 'failed';
  const sol = (Number(trade.amountRaw) / 1e9).toFixed(6);
  const outSol = trade.outAmount ? (Number(trade.outAmount) / 1e9).toFixed(6) : null;

  const DetailRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div style={{ display: 'flex', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
      <span className="text-[11px]" style={{ color: 'var(--text-3)', width: 88, flexShrink: 0, paddingTop: 1 }}>{label}</span>
      <span className="text-[12px] font-mono" style={{ color: 'var(--text)', wordBreak: 'break-all', flex: 1 }}>{children}</span>
    </div>
  );

  return (
    <div className="fade-in" style={{
      width: 300, flexShrink: 0, borderLeft: '1px solid var(--border)',
      background: 'var(--surface-2)', padding: '14px', display: 'flex', flexDirection: 'column', gap: 0,
    }}>
      {/* Header */}
      <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
        <span className="text-[12px] font-semibold" style={{ color: 'var(--text-2)' }}>Trade detail</span>
        <button className="btn btn-ghost btn-sm" style={{ height: 22, padding: '0 6px', fontSize: 13 }} onClick={onClose}>×</button>
      </div>

      {/* Status badge */}
      <div style={{ marginBottom: 10 }}>
        <span className={`chip ${ok ? 'chip-ok' : 'chip-bad'}`} style={{ fontSize: 11 }}>{trade.status.toUpperCase()}</span>
      </div>

      <DetailRow label="Token">
        {trade.mint}
      </DetailRow>
      <DetailRow label="Chain">{trade.chain}</DetailRow>
      <DetailRow label="Buy amount">{sol} SOL</DetailRow>
      {outSol && Number(outSol) > 0 && (
        <DetailRow label="Received">{outSol} (raw)</DetailRow>
      )}
      <DetailRow label="Group">{trade.groupId}</DetailRow>
      <DetailRow label="Time">{new Date(trade.createdAt).toLocaleString()}</DetailRow>

      {trade.txHash ? (
        <DetailRow label="Tx hash">
          <a href={`https://solscan.io/tx/${trade.txHash}`} target="_blank" rel="noopener"
            style={{ color: 'var(--accent)' }}>
            {trade.txHash.slice(0, 16)}…{trade.txHash.slice(-8)}
          </a>
        </DetailRow>
      ) : (
        <DetailRow label="Tx hash"><span style={{ color: 'var(--text-3)' }}>Not broadcast</span></DetailRow>
      )}

      {trade.errorMsg && (
        <div style={{ marginTop: 8 }}>
          <div className="text-[10px] font-medium mb-1" style={{ color: 'var(--bad)', letterSpacing: '0.08em' }}>FAILURE REASON</div>
          <div style={{
            background: 'color-mix(in srgb, var(--bad) 8%, var(--surface))',
            border: '1px solid color-mix(in srgb, var(--bad) 25%, transparent)',
            borderRadius: 6, padding: '8px 10px',
            fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--bad)',
            lineHeight: 1.5, wordBreak: 'break-word',
          }}>
            {trade.errorMsg}
          </div>
        </div>
      )}

      {trade.sourceMsg && (
        <div style={{ marginTop: 8 }}>
          <div className="text-[10px] font-medium mb-1" style={{ color: 'var(--text-3)', letterSpacing: '0.08em' }}>SOURCE MESSAGE</div>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '8px 10px',
            fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5,
            maxHeight: 80, overflowY: 'auto',
          }}>
            {trade.sourceMsg}
          </div>
        </div>
      )}

      {trade.sellStatus && (
        <div style={{ marginTop: 8 }}>
          <div className="text-[10px] font-medium mb-1" style={{ color: 'var(--text-3)', letterSpacing: '0.08em' }}>SELL</div>
          <div className="flex items-center gap-2">
            <span className="chip" style={{ fontSize: 10 }}>{trade.sellStatus}</span>
            {trade.sellReason && <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>{trade.sellReason}</span>}
          </div>
          {trade.sellTxHash && (
            <a href={`https://solscan.io/tx/${trade.sellTxHash}`} target="_blank" rel="noopener"
              className="font-mono text-[11px] block mt-1" style={{ color: 'var(--accent)' }}>
              {trade.sellTxHash.slice(0, 16)}…
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Page skeleton
───────────────────────────────────────────────────────────── */
function PageSkeleton() {
  return (
    <div className="page page-wide space-y-4">
      <div className="page-header"><Skeleton w={180} h={28} /><Skeleton w={200} h={22} rounded="md" /></div>
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        <div className="xl:col-span-2 space-y-4">
          <div className="panel space-y-3">{[...Array(3)].map((_, i) => <Skeleton key={i} h={36} rounded="md" />)}</div>
          <div className="panel space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} h={32} rounded="md" />)}</div>
        </div>
        <div className="xl:col-span-3 space-y-4">
          <div className="panel" style={{ height: INBOX_HEIGHT, padding: 0 }}><Skeleton h="100%" /></div>
          <div className="panel space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} h={32} rounded="md" />)}</div>
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

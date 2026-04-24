'use client';
import Link from 'next/link';
import { useAuth } from '../lib/auth-store';
import { useApi } from '../lib/useApi';
import { Skeleton } from '../components/ui/Skeleton';

interface Me {
  id: string;
  primaryWallet: string;
  paperMode: boolean;
}

export default function Landing() {
  const { accessToken, hydrated, logout } = useAuth();
  const { data: me, loading: loadingMe } = useApi<Me>('/me');
  const connected = hydrated && !!accessToken;

  return (
    <div className="w-full">
      {/* Hero */}
      <section className="relative py-8 md:py-14 px-4 md:px-0">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2 mb-5 flex-wrap fade-in">
            <span className="chip chip-accent">
              <span className="live-dot" />
              Live · Solana + EVM
            </span>
            <span className="chip">Paper + live mode</span>
          </div>

          <h1
            className="font-display font-semibold fade-in"
            style={{
              fontSize: 'clamp(30px, 6vw, 52px)',
              lineHeight: 1.05,
              letterSpacing: '-0.03em',
            }}
          >
            Your personal{' '}
            <span style={{ color: 'var(--accent)' }}>AI trading agent</span>.
            <br />
            <span style={{ color: 'var(--text-3)' }}>
              Learns your style. Executes 24/7.
            </span>
          </h1>

          <p
            className="mt-5 leading-relaxed fade-in"
            style={{
              fontSize: 14,
              color: 'var(--text-2)',
              maxWidth: 560,
            }}
          >
            QWAI learns your trading style, executes on Solana and EVM around the clock, monitors
            positions while you sleep, and chats naturally on web and Telegram.
          </p>

          <div className="mt-7">
            {!hydrated ? (
              <div className="flex gap-3">
                <Skeleton w={150} h={36} rounded="md" />
                <Skeleton w={120} h={36} rounded="md" />
              </div>
            ) : connected ? (
              <ConnectedCta me={me ?? null} loadingMe={loadingMe} onLogout={logout} />
            ) : (
              <DisconnectedCta />
            )}
          </div>
        </div>
      </section>

      <hr className="divider" />

      {/* Feature tiles */}
      <section className="py-10 px-4 md:px-0">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="section-eyebrow">What QWAI does</h2>
          <span className="text-[11px] font-mono" style={{ color: 'var(--text-3)' }}>
            {FEATURES.length.toString().padStart(2, '0')} modules
          </span>
        </div>
        <div className="grid-cards">
          {FEATURES.map((f, i) => (
            <FeatureTile key={f.title} {...f} index={i} />
          ))}
        </div>
      </section>

      {/* Supported rails */}
      <section className="py-10 pb-16 px-4 md:px-0">
        <h2 className="section-eyebrow mb-4">Built on</h2>
        <div className="flex flex-wrap gap-2">
          {RAILS.map((r) => (
            <span key={r} className="chip">
              {r}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ConnectedCta({
  me,
  loadingMe,
  onLogout,
}: {
  me: Me | null;
  loadingMe: boolean;
  onLogout: () => void;
}) {
  const addr = me?.primaryWallet;
  const short = addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '';
  return (
    <div
      className="cinematic-rise"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        boxShadow: 'var(--shadow-card)',
        padding: 16,
        maxWidth: 520,
      }}
    >
      <div className="flex items-center gap-3 mb-3">
        <div
          className="flex items-center justify-center font-semibold"
          style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'var(--accent)',
            color: 'var(--accent-fg)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.2)',
          }}
        >
          ✓
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold">Wallet connected</div>
          {loadingMe && !me ? (
            <Skeleton w={160} h={12} className="mt-1" />
          ) : (
            <div className="font-mono text-[12px] truncate" style={{ color: 'var(--text-2)' }}>
              {short || 'signed in'}
            </div>
          )}
        </div>
        {me && (
          <span className={me.paperMode ? 'chip chip-warn' : 'chip chip-ok'}>
            <span className="live-dot" style={{ background: me.paperMode ? 'var(--warn)' : 'var(--ok)' }} />
            {me.paperMode ? 'Paper' : 'Live'}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href="/dashboard" className="btn btn-primary">Go to dashboard →</Link>
        <Link href="/wallets" className="btn">Wallets</Link>
        <Link href="/analytics" className="btn">Analytics</Link>
        <button onClick={onLogout} className="btn btn-ghost">Sign out</button>
      </div>
    </div>
  );
}

function DisconnectedCta() {
  return (
    <div className="flex gap-2 flex-wrap fade-in">
      <Link href="/login" className="btn btn-primary btn-lg">Connect wallet</Link>
      <Link href="/dashboard" className="btn btn-lg">View demo</Link>
    </div>
  );
}

/* ------------------------------------------------------------------ */

type Feature = { title: string; body: string; glyph: string; tone: 'accent' | 'accent-2' };
const FEATURES: Feature[] = [
  { glyph: '◉', title: 'Autonomous agents',   body: 'DCA, stop-loss, copy-trade, snipe, position monitor — running 24/7.',                    tone: 'accent-2' },
  { glyph: '◐', title: 'Risk guardrails',     body: 'Per-trade caps, daily limits, white/blacklist, GoPlus + RugCheck pre-trade.',             tone: 'accent' },
  { glyph: '◆', title: 'Paper mode parity',   body: 'Practice with real market data and AI decisions. One-click switch to live.',              tone: 'accent' },
  { glyph: '⟡', title: 'Morning briefings',   body: 'Overnight P&L, filled orders, risk flags — delivered to web and Telegram.',               tone: 'accent-2' },
  { glyph: '⚡', title: 'Advanced orders',     body: 'Limit, trailing stop, bracket, DCA schedules — built into the chat interface.',           tone: 'accent' },
  { glyph: '◈', title: 'Token intel',         body: 'Contract scans, conviction scores, holder analysis on any Solana or EVM token.',           tone: 'accent-2' },
];

function FeatureTile({ title, body, glyph, tone, index }: Feature & { index: number }) {
  const col = tone === 'accent' ? 'var(--accent)' : 'var(--accent-2)';
  return (
    <div
      className="fade-in"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        boxShadow: 'var(--shadow-card)',
        padding: 14,
        animationDelay: `${Math.min(index * 50, 300)}ms`,
      }}
    >
      <div
        aria-hidden
        className="flex items-center justify-center"
        style={{
          width: 32, height: 32, borderRadius: 8,
          background: `color-mix(in srgb, ${col} 14%, var(--surface-2))`,
          color: col,
          border: `1px solid color-mix(in srgb, ${col} 30%, var(--border))`,
          fontSize: 17,
          marginBottom: 10,
        }}
      >
        {glyph}
      </div>
      <div className="text-[13px] font-semibold tracking-tight mb-1">{title}</div>
      <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-2)' }}>{body}</div>
    </div>
  );
}

const RAILS = [
  'Solana · Jupiter',
  'EVM · 1inch',
  'Helius',
  'Birdeye',
  'CoinGecko',
  'GoPlus',
  'RugCheck',
  'Anthropic / OpenAI',
  'Telegram',
  'Binance / Bybit / OKX',
];

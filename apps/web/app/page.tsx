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
    <div className="relative">
      {/* Hero */}
      <section className="pt-16 pb-14">
        <div className="max-w-5xl">
          <div className="flex items-center gap-2 mb-6">
            <span className="chip">
              <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--ok)]" />
              Live · Solana + EVM
            </span>
            <span className="chip">Paper + live mode</span>
          </div>
          <h1 className="text-[46px] font-semibold tracking-tight leading-[1.05] max-w-3xl">
            Your personal AI trading agent.{' '}
            <span style={{ color: 'var(--text-3)' }}>
              Learns your style. Executes 24/7.
            </span>
          </h1>
          <p className="text-[15px] text-[color:var(--text-2)] mt-6 max-w-2xl leading-relaxed">
            QWAI learns your trading style, executes on Solana and EVM 24/7, monitors positions
            while you sleep, and chats naturally on web and Telegram.
          </p>

          {/* Auth-aware CTA row */}
          <div className="mt-8">
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

      <hr className="divider my-4" />

      {/* Feature tiles */}
      <section className="py-10">
        <h2 className="section-title mb-6">What QWAI does</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((f) => (
            <FeatureTile key={f.title} {...f} />
          ))}
        </div>
      </section>

      {/* Supported rails */}
      <section className="py-10">
        <h2 className="section-title mb-6">Built on</h2>
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
    <div className="glass p-4 max-w-xl">
      <div className="flex items-center gap-3 mb-4">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center font-semibold text-[14px]"
          style={{
            background:
              'linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 70%, black) 100%)',
            color: 'var(--accent-fg)',
            boxShadow: '0 2px 10px var(--ring)',
          }}
        >
          ✓
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold">Wallet connected</div>
          {loadingMe && !me ? (
            <Skeleton w={160} h={12} className="mt-1" />
          ) : (
            <div className="font-mono text-[12px] text-[color:var(--text-2)] truncate">
              {short || 'signed in'}
            </div>
          )}
        </div>
        {me && (
          <span
            className="chip"
            style={{
              color: me.paperMode ? 'var(--warn)' : 'var(--ok)',
            }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: me.paperMode ? 'var(--warn)' : 'var(--ok)' }}
            />
            {me.paperMode ? 'Paper' : 'Live'}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href="/dashboard" className="btn btn-primary">
          Go to dashboard →
        </Link>
        <Link href="/wallets" className="btn">
          Wallets
        </Link>
        <Link href="/analytics" className="btn">
          Analytics
        </Link>
        <button onClick={onLogout} className="btn btn-ghost" title="Sign out">
          Sign out
        </button>
      </div>
    </div>
  );
}

function DisconnectedCta() {
  return (
    <div className="flex gap-3 flex-wrap">
      <Link href="/login" className="btn btn-primary">
        Connect wallet
      </Link>
      <Link href="/dashboard" className="btn">
        View demo
      </Link>
    </div>
  );
}

const FEATURES: { title: string; body: string; icon: string }[] = [
  {
    icon: '◉',
    title: 'Autonomous agents',
    body: 'DCA, stop-loss, copy-trade, snipe, position monitor — all running 24/7.',
  },
  {
    icon: '◐',
    title: 'Risk guardrails',
    body: 'Per-trade caps, daily limits, token white/blacklist, GoPlus + RugCheck pre-trade.',
  },
  {
    icon: '◆',
    title: 'Paper mode parity',
    body: 'Practice with real market data and AI decisions. One-click switch to live.',
  },
  {
    icon: '☼',
    title: 'Morning briefings',
    body: 'Overnight P&L, filled orders, risk flags — delivered to web and Telegram.',
  },
  {
    icon: '⚡',
    title: 'Advanced orders',
    body: 'Limit, trailing stop, bracket, DCA schedules — built into the chat interface.',
  },
  {
    icon: '◈',
    title: 'Token intel',
    body: 'Contract scans, conviction scores, holder analysis on any Solana or EVM token.',
  },
];

function FeatureTile({ title, body, icon }: { title: string; body: string; icon: string }) {
  return (
    <div className="panel hover:border-[color:var(--border-2)] transition-colors">
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center text-[18px] mb-3"
        style={{
          background: 'color-mix(in srgb, var(--accent) 10%, var(--surface-2))',
          color: 'var(--accent)',
          border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border))',
        }}
      >
        {icon}
      </div>
      <div className="text-[14px] font-semibold mb-1.5">{title}</div>
      <div className="text-[12.5px] text-[color:var(--text-2)] leading-relaxed">{body}</div>
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

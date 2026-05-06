'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect, useRef, type ReactNode } from 'react';
import ThemeToggle from './ThemeToggle';
import PaperModePill from './PaperModePill';
import LearningModePill from './LearningModePill';
import NotificationBell from './NotificationBell';
import UserMenu from './UserMenu';
import { TickerBar, type TickerItem } from './ui/TickerBar';
import { HotTokensBar } from './HotTokensBar';
import AgentLauncher from './AgentLauncher';
import NotificationBanner from './NotificationBanner';
import PumpStreakToast from './PumpStreakToast';
import SignalBanner from './SignalBanner';
import SignalQueuePanel from './SignalQueuePanel';
import { IntelTrackRail } from './IntelTrackRail';
import { useRealtime } from '../lib/useRealtime';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import { TokenPoolProvider } from '../lib/TokenPoolContext';

/**
 * AppShell — pro-terminal shell for qwai.
 * Left icon rail (product) + top statusbar with ticker + main workspace.
 * Marketing (/, /login) falls back to a slim topbar only.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() || '/';
  const isMarketing = pathname === '/' || pathname.startsWith('/login');

  if (isMarketing) {
    return (
      <div className="min-h-screen flex flex-col">
        <MarketingBar />
        <main className="flex-1 max-w-6xl mx-auto px-6 py-8 w-full">{children}</main>
      </div>
    );
  }

  return (
    <TokenPoolProvider>
    <SignalQueueProvider>
      {({ signalOpen, setSignalOpen, strongBuyCount }) => (
        <div className="shell-outer">
          <Rail pathname={pathname} onSignalToggle={() => setSignalOpen(!signalOpen)} signalCount={strongBuyCount} />
          <div className="shell-main-col flex-1 flex flex-col min-w-0">
            <TopStatusBar />
            <SignalBanner />
            <HotTokensBar />
            <main className="shell-scroll min-w-0">{children}</main>
            <BottomStatusBar />
          </div>
          <SignalQueuePanel open={signalOpen} onClose={() => setSignalOpen(false)} />
          <IntelTrackDrawer />
          <MobileTabBar pathname={pathname} />
          <AgentLauncher />
          <NotificationBanner />
          <PumpStreakToast />
        </div>
      )}
    </SignalQueueProvider>
    </TokenPoolProvider>
  );
}

/* ============================================================ */
/* Intel Track Drawer — slide-out from the right edge            */
/* Tab is fixed-pinned. Click → expand panel showing top calls.  */
/* ============================================================ */
function IntelTrackDrawer() {
  const [open, setOpen] = useState(false);
  // Persist preference so the drawer state survives page nav.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('qwai_intel_track_drawer');
      if (saved === 'open') setOpen(true);
    } catch { /* ignore */ }
  }, []);
  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      try { localStorage.setItem('qwai_intel_track_drawer', next ? 'open' : 'closed'); } catch { /* ignore */ }
      return next;
    });
  };
  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={open ? 'Hide track record' : 'Show track record'}
        title="Track Record"
        className="hide-mobile"
        style={{
          position: 'fixed',
          right: open ? 280 : 0,
          top: 'calc(50vh - 60px)',
          zIndex: 30,
          width: 24,
          height: 80,
          borderRadius: '8px 0 0 8px',
          border: '1px solid var(--border)',
          borderRight: 0,
          background: 'var(--surface-2)',
          color: 'var(--text-2)',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          transition: 'right 0.18s ease',
        }}
      >
        {open ? '×' : 'TRACK ↤'}
      </button>
      <aside
        className="hide-mobile"
        aria-hidden={!open}
        style={{
          position: 'fixed',
          right: open ? 0 : -300,
          top: 0, bottom: 0,
          width: 280,
          background: 'var(--surface)',
          borderLeft: '1px solid var(--border)',
          padding: '16px 10px 14px',
          overflowY: 'auto',
          zIndex: 25,
          transition: 'right 0.22s ease',
          boxShadow: open ? '-12px 0 24px rgba(0,0,0,0.25)' : 'none',
        }}
      >
        {open && <IntelTrackRail />}
      </aside>
    </>
  );
}

/* ============================================================ */
/* Mobile bottom tab bar                                        */
/* ============================================================ */

const MOBILE_TABS: { href: string; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { href: '/dashboard', label: 'Home',     icon: IconDashboard },
  { href: '/snipe',     label: 'Snipe',    icon: IconSnipe },
  { href: '/chat',      label: 'Chat',     icon: IconChat },
  { href: '/portfolio', label: 'Portfolio',icon: IconPortfolio },
  { href: '/settings',  label: 'More',     icon: IconSettings },
];

function MobileTabBar({ pathname }: { pathname: string }) {
  return (
    <nav className="mobile-tabbar" aria-label="Primary">
      {MOBILE_TABS.map(({ href, label, icon: Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link key={href} href={href} className={`tab ${active ? 'active' : ''}`} aria-label={label}>
            <Icon size={18} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/* ============================================================ */
/* Signal queue state provider (counts strong buys for badge)   */
/* ============================================================ */

function SignalQueueProvider({
  children,
}: {
  children: (ctx: { signalOpen: boolean; setSignalOpen: (open: boolean) => void; strongBuyCount: number }) => React.ReactNode;
}) {
  const [signalOpen, setSignalOpen] = useState(false);
  const [strongBuyCount, setStrongBuyCount] = useState(0);

  useRealtime('signal_alert', () => {
    setStrongBuyCount((n) => n + 1);
  });

  const handleSetOpen = (open: boolean) => {
    setSignalOpen(open);
    if (open) setStrongBuyCount(0);
  };

  return <>{children({ signalOpen, setSignalOpen: handleSetOpen, strongBuyCount })}</>;
}

/* ============================================================ */
/* Rail                                                         */
/* ============================================================ */

type RailItem = { href: string; label: string; icon: (props: { size?: number }) => JSX.Element };
type RailGroup = { category: string; items: RailItem[] };

const RAIL_GROUPS: RailGroup[] = [
  {
    category: 'Feed',
    items: [
      { href: '/hot-feed',    label: 'Hot Feed', icon: IconFlame    },
      { href: '/intel',       label: 'Analyze',  icon: IconScan     },
      { href: '/intel-track', label: 'Track',    icon: IconTrophy   },
    ],
  },
  {
    category: 'Trade',
    items: [
      { href: '/trade',     label: 'Trade',     icon: IconTrade     },
      { href: '/snipe',     label: 'Sniper',    icon: IconSnipe     },
      { href: '/portfolio', label: 'Portfolio', icon: IconPortfolio },
    ],
  },
  {
    category: 'Tools',
    items: [
      { href: '/agents',    label: 'Agents',    icon: IconAgents    },
      { href: '/chat',      label: 'Chat',      icon: IconChat      },
      { href: '/wallets',   label: 'Wallets',   icon: IconWallet    },
      { href: '/analytics', label: 'Analytics', icon: IconAnalytics },
      { href: '/social',    label: 'Social',    icon: IconSocial    },
    ],
  },
];

function Rail({ pathname, onSignalToggle, signalCount }: { pathname: string; onSignalToggle: () => void; signalCount: number }) {
  return (
    <aside className="rail">
      {/* Brand */}
      <Link href="/" className="rail-brand" aria-label="QWAI home">
        <QwaiMark size={24} />
      </Link>

      {/* Dashboard — top of rail before categories */}
      <Link
        href="/dashboard"
        className={`rail-item ${pathname.startsWith('/dashboard') ? 'active' : ''}`}
        aria-label="Dashboard"
      >
        <IconDashboard size={16} />
        <span className="rail-label">Home</span>
      </Link>

      {/* Signal queue toggle */}
      <button
        onClick={onSignalToggle}
        className="rail-item"
        aria-label="Signal queue"
        style={{ position: 'relative' }}
      >
        <div style={{ position: 'relative' }}>
          <IconSignal size={16} />
          {signalCount > 0 && (
            <span style={{
              position: 'absolute', top: -4, right: -6,
              width: 13, height: 13, borderRadius: '50%',
              background: 'var(--ok)', color: '#fff',
              fontSize: 7, fontWeight: 800,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {signalCount > 9 ? '9+' : signalCount}
            </span>
          )}
        </div>
        <span className="rail-label" style={{ color: signalCount > 0 ? 'var(--ok)' : undefined }}>
          Signals
        </span>
      </button>

      {/* Category groups */}
      {RAIL_GROUPS.map((group) => (
        <div key={group.category} className="rail-group">
          <div className="rail-group-label">{group.category}</div>
          {group.items.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`rail-item ${active ? 'active' : ''}`}
                aria-label={label}
              >
                <Icon size={16} />
                <span className="rail-label">{label}</span>
              </Link>
            );
          })}
        </div>
      ))}

      <div className="rail-spacer" />

      <Link
        href="/settings"
        className={`rail-item ${pathname.startsWith('/settings') ? 'active' : ''}`}
        aria-label="Settings"
      >
        <IconSettings size={16} />
        <span className="rail-label">Settings</span>
      </Link>
    </aside>
  );
}

/* ============================================================ */
/* Top statusbar (ticker + balance + ⌘K + paper/live + menu)     */
/* ============================================================ */

const TICKER_COINS = [
  { id: 'solana',   symbol: 'SOL' },
  { id: 'bitcoin',  symbol: 'BTC' },
  { id: 'ethereum', symbol: 'ETH' },
  { id: 'jupiter-exchange-solana', symbol: 'JUP' },
  { id: 'dogwifcoin', symbol: 'WIF' },
  { id: 'bonk',    symbol: 'BONK' },
];

function useLiveTicker(): TickerItem[] {
  const [items, setItems] = useState<TickerItem[]>([]);
  const prevPrices = useRef<Record<string, number>>({});

  useEffect(() => {
    const ids = TICKER_COINS.map((c) => c.id).join(',');

    async function fetchPrices() {
      try {
        const resp = await api.get<Record<string, number | null>>(`/market/prices?ids=${ids}`);
        const next: TickerItem[] = [];
        for (const coin of TICKER_COINS) {
          const price = resp.data[coin.id];
          if (price == null) continue;
          const prev = prevPrices.current[coin.id];
          const delta = prev != null && prev !== 0 ? ((price - prev) / prev) * 100 : 0;
          prevPrices.current[coin.id] = price;
          next.push({
            symbol: coin.symbol,
            price: price >= 1000
              ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
              : price >= 1
              ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
              : `$${price.toFixed(6)}`,
            delta: `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`,
            tone: delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : 'flat',
          });
        }
        if (next.length > 0) setItems(next);
      } catch {
        // silently keep last known prices on failure
      }
    }

    fetchPrices();
    const timer = setInterval(fetchPrices, 30_000);
    return () => clearInterval(timer);
  }, []);

  return items;
}

function TopStatusBar() {
  const [cmdOpen, setCmdOpen] = useState(false);
  const tickerItems = useLiveTicker();

  return (
    <div className="statusbar">
      <Link href="/" className="show-mobile flex items-center gap-2 pl-3 pr-2 h-full shrink-0" aria-label="QWAI home"
        style={{ minWidth: 0, overflow: 'hidden' }}>
        <QwaiMark size={22} />
        <span className="font-display font-semibold text-[14px] tracking-tight" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>QWAI</span>
      </Link>
      <div className="hide-mobile flex items-center gap-3 pl-4 pr-2 h-full shrink-0" style={{ borderRight: '1px solid var(--border)' }}>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => setCmdOpen(true)}
          style={{ gap: 8 }}
          aria-label="Open command bar"
          title="⌘K"
        >
          <IconSearch size={14} />
          <span className="mobile-search-label" style={{ color: 'var(--text-3)' }}>Search…</span>
          <span className="kbd" style={{ marginLeft: 8 }}>⌘K</span>
        </button>
      </div>
      <TickerBar items={tickerItems} />
      <div className="flex items-center gap-1 md:gap-2 pr-2 md:pr-3 md:pl-3 h-full ml-auto shrink-0" style={{ borderLeft: '1px solid var(--border)' }}>
        <button
          className="btn-icon show-mobile"
          onClick={() => setCmdOpen(true)}
          aria-label="Search"
          title="Search"
          style={{ minWidth: 44, minHeight: 44 }}
        >
          <IconSearch size={16} />
        </button>
        <div className="hide-sm flex items-center gap-1 md:gap-2">
          <PaperModePill />
          <LearningModePill />
        </div>
        <NotificationBell />
        <UserMenu />
        <ThemeToggle />
      </div>
      {cmdOpen && <CmdStub onClose={() => setCmdOpen(false)} />}
    </div>
  );
}

function CmdStub({ onClose }: { onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: 120,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="section cinematic-rise"
        style={{ width: 520, maxWidth: '90%' }}
      >
        <div className="section-header">
          <input
            autoFocus
            className="input"
            placeholder="Search tokens, commands, pages…"
            style={{ border: 'none', background: 'transparent', boxShadow: 'none', height: 32 }}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
          />
        </div>
        <div className="section-body" style={{ color: 'var(--text-3)', fontSize: 12 }}>
          Command bar coming soon. Press <span className="kbd">Esc</span> to close.
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/* Bottom statusbar                                             */
/* ============================================================ */

function BottomStatusBar() {
  const { data: agents, error: agentsErr } = useApi<{ id: string; status: string }[]>('/agents', { pollMs: 30_000 });
  const { data: perf }                     = useApi<{ totalPnl: number; weekly: { pnl: number } }>('/analytics/performance', { pollMs: 60_000 });
  // Must use '/me' — same key as PaperModePill — so mutate('/me') propagates here instantly.
  const { data: me, error: meErr }         = useApi<{ paperMode: boolean }>('/me', { pollMs: 60_000 });

  const running = agents?.filter((a) => a.status === 'RUNNING').length ?? null;
  const pnl7d   = perf?.weekly?.pnl ?? null;
  const isPaper = me?.paperMode ?? null;
  const apiDown = !!(meErr && agentsErr); // both failed → likely offline

  return (
    <div className="statusbar-bottom">
      {/* API connectivity */}
      <span>
        <span style={{ color: 'var(--text-2)' }}>status</span>{' '}
        <span style={{ color: apiDown ? 'var(--bad)' : 'var(--ok)' }}>
          ● {apiDown ? 'offline' : 'online'}
        </span>
      </span>
      <span className="sep" />

      {/* Trade mode — live from /me, in sync with PaperModePill */}
      <span>
        <span style={{ color: 'var(--text-2)' }}>mode</span>{' '}
        {isPaper === null ? (
          <span style={{ color: 'var(--text-3)' }}>—</span>
        ) : (
          <span style={{ color: isPaper ? 'var(--warn)' : 'var(--ok)', fontWeight: 500 }}>
            {isPaper ? 'paper' : 'live'}
          </span>
        )}
      </span>
      <span className="sep" />

      {/* Running agents */}
      <span>
        <span style={{ color: 'var(--text-2)' }}>agents</span>{' '}
        <span style={{ color: 'var(--text)' }}>
          {running === null ? '—' : `${running} running`}
        </span>
      </span>
      <span className="sep" />

      {/* 7-day P&L */}
      <span>
        <span style={{ color: 'var(--text-2)' }}>7d pnl</span>{' '}
        {pnl7d === null ? (
          <span style={{ color: 'var(--text-3)' }}>—</span>
        ) : (
          <span style={{ color: pnl7d >= 0 ? 'var(--ok)' : 'var(--bad)' }}>
            {pnl7d >= 0 ? '+' : ''}${Math.abs(pnl7d).toFixed(2)}
          </span>
        )}
      </span>
      <span className="sep" />

      <span style={{ marginLeft: 'auto' }}>
        <span style={{ color: 'var(--text-3)' }}>qwai v0.1 · solana + evm</span>
      </span>
    </div>
  );
}

/* ============================================================ */
/* Marketing bar (landing, login)                               */
/* ============================================================ */

function MarketingBar() {
  return (
    <nav
      className="sticky top-0 z-40"
      style={{
        background: 'color-mix(in srgb, var(--bg) 88%, transparent)',
        borderBottom: '1px solid var(--border)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <div className="max-w-6xl mx-auto px-4 md:px-6 h-14 flex items-center">
        <Link href="/" className="flex items-center gap-2.5 mr-6">
          <QwaiMark size={22} />
          <span className="font-display font-semibold text-[15px] tracking-tight">QWAI</span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/login" className="btn btn-sm">Connect wallet</Link>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}

/* ============================================================ */
/* Icons                                                        */
/* ============================================================ */

export function QwaiMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="qwai-shell-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <path
        d="M32 10 L52 22 L52 42 L32 54 L12 42 L12 22 Z"
        fill="none"
        stroke="url(#qwai-shell-grad)"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="32" r="5" fill="url(#qwai-shell-grad)" />
      <path d="M36 36 L48 48" stroke="url(#qwai-shell-grad)" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Solid-filled icon system. Tabler/Heroicons-solid weight — no thin strokes,
 * no border-only outlines. Each glyph is a single filled path (or composition)
 * using fill="currentColor" so the rail's active state colours flow through.
 *
 * Why filled over outline: a high-density rail of 14 icons with thin strokes
 * reads as visual noise; filled glyphs are unambiguously legible at 18px and
 * look intentional next to the loud accent active-state pill.
 */
function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function IconDashboard({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M3 3h7v9H3z" />
      <path d="M14 3h7v5h-7z" />
      <path d="M14 12h7v9h-7z" />
      <path d="M3 16h7v5H3z" />
    </Svg>
  );
}
function IconWallet({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M3 6a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2H5a1 1 0 0 0 0 2h15a1 1 0 0 1 1 1v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6zm14 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
    </Svg>
  );
}
function IconChat({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M3 11.5C3 6.8 7 3 12 3s9 3.8 9 8.5-4 8.5-9 8.5c-1 0-2-.2-3-.5L4.7 21a.5.5 0 0 1-.7-.6l1-3.6c-1.3-1.5-2-3.3-2-5.3z" />
    </Svg>
  );
}
function IconAnalytics({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M3 20a1 1 0 0 1 1-1h17a1 1 0 0 1 0 2H4a1 1 0 0 1-1-1z" />
      <path d="M5 9h2v8H5zm5-5h2v13h-2zm5 6h2v7h-2zm5-3h2v10h-2z" />
    </Svg>
  );
}
function IconSocial({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="8.5" cy="7" r="3" />
      <circle cx="17" cy="17" r="3" />
      <path d="M3 19c0-3 2.5-5 5.5-5h.5l5 5H3.5a.5.5 0 0 1-.5-.5V19zm10.5-9h.5l5 5h-.5C15.5 15 13 13 13 10z" />
    </Svg>
  );
}
function IconSettings({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M19.5 12c0-.5 0-.9-.1-1.4l2-1.5-2-3.5-2.4.8c-.7-.6-1.5-1-2.4-1.4L14 2.5h-4l-.6 2.5c-.9.4-1.7.8-2.4 1.4l-2.4-.8-2 3.5 2 1.5c-.1.5-.1.9-.1 1.4s0 .9.1 1.4l-2 1.5 2 3.5 2.4-.8c.7.6 1.5 1 2.4 1.4l.6 2.5h4l.6-2.5c.9-.4 1.7-.8 2.4-1.4l2.4.8 2-3.5-2-1.5c.1-.5.1-.9.1-1.4zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8z" />
    </Svg>
  );
}
function IconDesign({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 11h6v-2h-6V5h-2v8h8z" opacity="0" />
      <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm5 11h-6V6h2v5h4z" />
    </Svg>
  );
}
function IconSearch({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M11 4a7 7 0 1 0 4.4 12.4l3.4 3.4a1 1 0 0 0 1.4-1.4l-3.4-3.4A7 7 0 0 0 11 4zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z" />
    </Svg>
  );
}
function IconTrade({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M21 7a1 1 0 0 0-1-1h-5a1 1 0 0 0 0 2h2.6l-5.6 5.6-3.3-3.3a1 1 0 0 0-1.4 0l-6 6a1 1 0 0 0 1.4 1.4L8 12.4l3.3 3.3a1 1 0 0 0 1.4 0L19 9.4V12a1 1 0 0 0 2 0z" />
    </Svg>
  );
}
function IconSnipe({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M13 2 3.4 13.5a.5.5 0 0 0 .4.8H11l-1 7.4a.5.5 0 0 0 .9.3l9.7-11.5a.5.5 0 0 0-.4-.8H14l1-7.4a.5.5 0 0 0-.9-.3z" />
    </Svg>
  );
}
function IconAgents({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M12 13c-3.9 0-7 2.5-7 6 0 .6.4 1 1 1h12c.6 0 1-.4 1-1 0-3.5-3.1-6-7-6z" />
      <path d="M11 2h2v2.5h-2zM3.5 7.5h2.5v2H3.5zM18 7.5h2.5v2H18z" />
    </Svg>
  );
}
function IconGem({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M6 3h12l3 6-9 12L3 9zm0 6h12L12 16z" />
    </Svg>
  );
}
function IconScan({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M5 3h3a1 1 0 0 1 0 2H5v3a1 1 0 0 1-2 0V5a2 2 0 0 1 2-2zm14 0a2 2 0 0 1 2 2v3a1 1 0 0 1-2 0V5h-3a1 1 0 0 1 0-2zM4 15a1 1 0 0 1 1 1v3h3a1 1 0 0 1 0 2H5a2 2 0 0 1-2-2v-3a1 1 0 0 1 1-1zm16 0a1 1 0 0 1 1 1v3a2 2 0 0 1-2 2h-3a1 1 0 0 1 0-2h3v-3a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="12" r="3.5" />
    </Svg>
  );
}
function IconFlame({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M12 2c1 4 4 5 4 9a4 4 0 1 1-8 0c0-2 .8-3 2-4-.5 2 .5 3 1 3 0-3-1-5 1-8zm-3 14a3 3 0 0 0 6 0c0-1.2-.8-2-1.5-2.5.2 1.5-.5 2-1 2 0-1.4-.5-2.5-1.5-3-.5 1-2 2-2 3.5z" />
    </Svg>
  );
}
function IconTrophy({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M7 4h10v2h3a1 1 0 0 1 1 1v2a4 4 0 0 1-4 4 6 6 0 0 1-4 3v2h3a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1h3v-2a6 6 0 0 1-4-3 4 4 0 0 1-4-4V7a1 1 0 0 1 1-1h3V4zm0 4H5v1a2 2 0 0 0 2 2zm10 3a2 2 0 0 0 2-2V8h-2z" />
    </Svg>
  );
}
function IconPortfolio({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="3" y="13" width="5" height="8" rx="1" />
      <rect x="9.5" y="8" width="5" height="13" rx="1" />
      <rect x="16" y="3" width="5" height="18" rx="1" />
    </Svg>
  );
}
function IconSignal({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M3 18a1 1 0 0 1 1-1h1a1 1 0 0 1 0 2H4a1 1 0 0 1-1-1zm4-3a1 1 0 0 1 1-1h1a1 1 0 0 1 0 2H8a1 1 0 0 1-1-1zm4-3a1 1 0 0 1 1-1h1a1 1 0 0 1 0 2h-1a1 1 0 0 1-1-1zm4-3a1 1 0 0 1 1-1h1a1 1 0 0 1 0 2h-1a1 1 0 0 1-1-1z" />
      <path d="M5.3 6.3a1 1 0 0 1 1.4 0A9 9 0 0 1 12 4a9 9 0 0 1 5.3 2.3 1 1 0 0 1-1.4 1.4A7 7 0 0 0 12 6a7 7 0 0 0-3.9 1.7 1 1 0 0 1-1.4-1.4z" />
      <path d="M8.1 9.1a1 1 0 0 1 1.4 0A5 5 0 0 1 12 8a5 5 0 0 1 2.5.9 1 1 0 1 1-1 1.7A3 3 0 0 0 12 10a3 3 0 0 0-1.5.5 1 1 0 0 1-1.4-1.4z" />
      <circle cx="12" cy="18" r="1.5" />
    </Svg>
  );
}

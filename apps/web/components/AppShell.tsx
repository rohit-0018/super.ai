'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import ThemeToggle from './ThemeToggle';
import PaperModePill from './PaperModePill';
import LearningModePill from './LearningModePill';
import NotificationBell from './NotificationBell';
import UserMenu from './UserMenu';
import { TickerBar, type TickerItem } from './ui/TickerBar';
import AgentLauncher from './AgentLauncher';

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
    <div className="flex min-h-screen">
      <Rail pathname={pathname} />
      <div className="shell-main-col flex-1 flex flex-col min-w-0">
        <TopStatusBar />
        <main className="flex-1 min-w-0">{children}</main>
        <BottomStatusBar />
      </div>
      <MobileTabBar pathname={pathname} />
      <AgentLauncher />
    </div>
  );
}

/* ============================================================ */
/* Mobile bottom tab bar                                        */
/* ============================================================ */

const MOBILE_TABS: { href: string; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { href: '/dashboard', label: 'Home',     icon: IconDashboard },
  { href: '/trade',     label: 'Trade',    icon: IconTrade },
  { href: '/agents',    label: 'Agents',   icon: IconAgents },
  { href: '/chat',      label: 'Chat',     icon: IconChat },
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
/* Rail                                                         */
/* ============================================================ */

const RAIL_ITEMS: { href: string; label: string; icon: (props: { size?: number }) => JSX.Element }[] = [
  { href: '/dashboard', label: 'Dashboard', icon: IconDashboard },
  { href: '/trade',     label: 'Trade',     icon: IconTrade },
  { href: '/agents',    label: 'Agents',    icon: IconAgents },
  { href: '/snipe',     label: 'Sniper',    icon: IconSnipe },
  { href: '/tokens',    label: 'Tokens',    icon: IconGem },
  { href: '/wallets',   label: 'Wallets',   icon: IconWallet },
  { href: '/chat',      label: 'Chat',      icon: IconChat },
  { href: '/analytics', label: 'Analytics', icon: IconAnalytics },
  { href: '/social',    label: 'Social',    icon: IconSocial },
];

function Rail({ pathname }: { pathname: string }) {
  return (
    <aside className="rail">
      <Link href="/" className="rail-brand" aria-label="QWAI home">
        <QwaiMark size={26} />
      </Link>
      {RAIL_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`rail-item ${active ? 'active' : ''}`}
            aria-label={label}
            title={label}
          >
            <Icon size={18} />
          </Link>
        );
      })}
      <div className="rail-spacer" />
      <Link
        href="/settings"
        className={`rail-item ${pathname.startsWith('/settings') ? 'active' : ''}`}
        aria-label="Settings"
        title="Settings"
      >
        <IconSettings size={18} />
      </Link>
      <Link
        href="/design"
        className={`rail-item ${pathname.startsWith('/design') ? 'active' : ''}`}
        aria-label="Design kit"
        title="Design kit"
      >
        <IconDesign size={18} />
      </Link>
    </aside>
  );
}

/* ============================================================ */
/* Top statusbar (ticker + balance + ⌘K + paper/live + menu)     */
/* ============================================================ */

const DEMO_TICKER: TickerItem[] = [
  { symbol: 'SOL',  price: '$142.33', delta: '+4.2%', tone: 'up' },
  { symbol: 'BTC',  price: '$68,120', delta: '-0.8%', tone: 'down' },
  { symbol: 'ETH',  price: '$3,214',  delta: '+1.1%', tone: 'up' },
  { symbol: 'JUP',  price: '$0.82',   delta: '+2.4%', tone: 'up' },
  { symbol: 'WIF',  price: '$1.94',   delta: '-3.2%', tone: 'down' },
  { symbol: 'BONK', price: '$0.0000234', delta: '+5.1%', tone: 'up' },
];

function TopStatusBar() {
  const [cmdOpen, setCmdOpen] = useState(false);
  return (
    <div className="statusbar">
      {/* Mobile-only brand on the left */}
      <Link href="/" className="show-mobile flex items-center gap-2 pl-3 pr-2 h-full" aria-label="QWAI home">
        <QwaiMark size={22} />
        <span className="font-display font-semibold text-[14px] tracking-tight">QWAI</span>
      </Link>
      {/* Desktop: search + ticker */}
      <div className="hide-mobile flex items-center gap-3 pl-4 pr-2 h-full" style={{ borderRight: '1px solid var(--border)' }}>
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
      <TickerBar items={DEMO_TICKER} />
      <div className="flex items-center gap-1 md:gap-2 pr-2 md:pr-3 md:pl-3 h-full ml-auto" style={{ borderLeft: '1px solid var(--border)' }}>
        <button
          className="btn-icon show-mobile"
          onClick={() => setCmdOpen(true)}
          aria-label="Search"
          title="Search"
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
  return (
    <div className="statusbar-bottom">
      <span>
        <span style={{ color: 'var(--text-2)' }}>status</span>{' '}
        <span style={{ color: 'var(--ok)' }}>● online</span>
      </span>
      <span className="sep" />
      <span>
        <span style={{ color: 'var(--text-2)' }}>mode</span>{' '}
        <span style={{ color: 'var(--warn)' }}>paper</span>
      </span>
      <span className="sep" />
      <span>
        <span style={{ color: 'var(--text-2)' }}>risk</span>{' '}
        <span style={{ color: 'var(--text)' }}>low</span>
      </span>
      <span className="sep" />
      <span>
        <span style={{ color: 'var(--text-2)' }}>agents</span>{' '}
        <span style={{ color: 'var(--text)' }}>3 running</span>
      </span>
      <span className="sep" />
      <span>
        <span style={{ color: 'var(--text-2)' }}>24h</span>{' '}
        <span style={{ color: 'var(--ok)' }}>+2.31%</span>
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

function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function IconDashboard({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </Svg>
  );
}
function IconWallet({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M16 12h3" />
      <path d="M3 10h18" />
    </Svg>
  );
}
function IconChat({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M21 12a8 8 0 0 1-11.3 7.3L4 21l1.7-5.7A8 8 0 1 1 21 12z" />
    </Svg>
  );
}
function IconAnalytics({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M3 20h18" />
      <path d="M6 16V9" />
      <path d="M11 16V5" />
      <path d="M16 16v-4" />
      <path d="M21 16V8" />
    </Svg>
  );
}
function IconSocial({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="9" cy="7" r="3" />
      <circle cx="17" cy="17" r="3" />
      <path d="M6 14c-1.7 0-3 1.3-3 3v3h8" />
      <path d="M14 6c1.7 0 3 1.3 3 3v3" />
    </Svg>
  );
}
function IconSettings({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </Svg>
  );
}
function IconDesign({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v9l6 3" />
    </Svg>
  );
}
function IconSearch({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}
function IconTrade({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M21 7h-5" />
      <path d="M21 7v5" />
    </Svg>
  );
}
function IconSnipe({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </Svg>
  );
}
function IconAgents({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="8" r="3" />
      <path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" />
      <path d="M12 2v2" />
      <path d="M4 8h2" />
      <path d="M18 8h2" />
    </Svg>
  );
}
function IconGem({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M6 3h12l3 6-9 12L3 9z" />
      <path d="M3 9h18" />
    </Svg>
  );
}

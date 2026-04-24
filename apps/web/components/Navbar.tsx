'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import ThemeToggle from './ThemeToggle';
import PaperModePill from './PaperModePill';
import LearningModePill from './LearningModePill';
import NotificationBell from './NotificationBell';
import UserMenu from './UserMenu';

const links: [string, string][] = [
  ['/dashboard', 'Dashboard'],
  ['/wallets', 'Wallets'],
  ['/chat', 'Chat'],
  ['/analytics', 'Analytics'],
  ['/social', 'Social'],
  ['/settings', 'Settings'],
];

export default function Navbar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav
      className="sticky top-0 z-40 backdrop-blur-xl"
      style={{
        background: 'color-mix(in srgb, var(--bg) 72%, transparent)',
        borderBottom: '1px solid color-mix(in srgb, var(--border) 75%, transparent)',
        boxShadow: '0 1px 0 0 color-mix(in srgb, var(--accent) 5%, transparent)',
      }}
    >
      <div className="max-w-7xl mx-auto px-4 md:px-6 h-14 flex items-center">
        <Link href="/" className="flex items-center gap-2.5 mr-6 md:mr-8 group">
          <QwaiMark />
          <span className="font-display font-semibold text-[15px] tracking-tight">
            QWAI
          </span>
        </Link>

        {/* Desktop links */}
        <div className="hidden md:flex items-center gap-0.5">
          {links.map(([href, label]) => {
            const active = pathname?.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className="relative px-3 h-8 flex items-center rounded-md text-[13px] font-medium transition-all"
                style={
                  active
                    ? {
                        color: 'var(--text)',
                        background: 'color-mix(in srgb, var(--accent) 10%, var(--surface-hover) 85%)',
                        boxShadow:
                          'inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent), 0 0 18px -6px var(--glow-cyan)',
                      }
                    : { color: 'var(--text-2)' }
                }
              >
                {label}
              </Link>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-1.5 md:gap-2">
          <PaperModePill />
          <LearningModePill />
          <NotificationBell />
          <UserMenu />
          <ThemeToggle />
          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileOpen((v) => !v)}
            className="md:hidden w-9 h-9 rounded-md flex items-center justify-center hover:bg-[color:var(--surface-hover)] transition-colors"
            aria-label="Toggle menu"
          >
            {mobileOpen ? <XIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div
          className="md:hidden fade-in"
          style={{
            borderTop: '1px solid var(--border)',
            background: 'color-mix(in srgb, var(--bg) 92%, transparent)',
            backdropFilter: 'blur(18px)',
          }}
        >
          <div className="max-w-7xl mx-auto px-4 py-3">
            <div className="grid gap-0.5">
              {links.map(([href, label]) => {
                const active = pathname?.startsWith(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setMobileOpen(false)}
                    className="px-3 h-10 flex items-center rounded-md text-[14px] font-medium transition-colors"
                    style={
                      active
                        ? {
                            color: 'var(--text)',
                            background: 'color-mix(in srgb, var(--accent) 10%, var(--surface-hover) 85%)',
                            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent)',
                          }
                        : { color: 'var(--text-2)' }
                    }
                  >
                    {label}
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}

function QwaiMark() {
  return (
    <span className="hex-mark" aria-hidden>
      <svg viewBox="0 0 64 64" width="24" height="24">
        <defs>
          <linearGradient id="nav-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#22d3ee" />
            <stop offset="1" stopColor="#c084fc" />
          </linearGradient>
        </defs>
        <path
          d="M32 10 L52 22 L52 42 L32 54 L12 42 L12 22 Z"
          fill="none"
          stroke="url(#nav-grad)"
          strokeWidth="3.5"
          strokeLinejoin="round"
        />
        <circle cx="32" cy="32" r="5" fill="url(#nav-grad)" />
        <path d="M36 36 L48 48" stroke="url(#nav-grad)" strokeWidth="3.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

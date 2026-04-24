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
    <nav className="sticky top-0 z-40 border-b border-border bg-[color:color-mix(in_srgb,var(--bg)_92%,transparent)] backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 md:px-6 h-14 flex items-center">
        <Link href="/" className="flex items-center gap-2 mr-6 md:mr-8">
          <div
            className="w-6 h-6 rounded-md flex items-center justify-center"
            style={{
              background:
                'linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 60%, black) 100%)',
            }}
          >
            <span
              className="font-bold text-[11px]"
              style={{ color: 'white', fontFamily: 'var(--font-mono)' }}
            >
              Q
            </span>
          </div>
          <span className="font-semibold text-[15px] tracking-tight">QWAI</span>
        </Link>

        {/* Desktop links */}
        <div className="hidden md:flex items-center gap-0.5">
          {links.map(([href, label]) => {
            const active = pathname?.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`px-3 h-8 flex items-center rounded-md text-[13px] font-medium transition-colors ${
                  active
                    ? 'text-text bg-[color:var(--surface-hover)]'
                    : 'text-[color:var(--text-2)] hover:text-text hover:bg-[color:var(--surface-hover)]'
                }`}
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
        <div className="md:hidden border-t border-border bg-[color:var(--bg)] fade-in">
          <div className="max-w-7xl mx-auto px-4 py-3">
            <div className="grid gap-0.5">
              {links.map(([href, label]) => {
                const active = pathname?.startsWith(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setMobileOpen(false)}
                    className={`px-3 h-10 flex items-center rounded-md text-[14px] font-medium transition-colors ${
                      active
                        ? 'text-text bg-[color:var(--surface-hover)]'
                        : 'text-[color:var(--text-2)] hover:text-text hover:bg-[color:var(--surface-hover)]'
                    }`}
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

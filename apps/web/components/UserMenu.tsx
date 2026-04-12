'use client';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth-store';
import { api } from '../lib/api';
import { Skeleton } from './ui/Skeleton';

interface Me { id: string; primaryWallet: string; paperMode: boolean; }

export default function UserMenu() {
  const { accessToken, hydrated, logout } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hydrated || !accessToken) { setMe(null); return; }
    let cancelled = false;
    api
      .get<Me>('/me')
      .then((r) => { if (!cancelled) setMe(r.data); })
      .catch(() => { if (!cancelled) setMe(null); });
    return () => { cancelled = true; };
  }, [hydrated, accessToken]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  if (!hydrated || !accessToken) return null;

  const addr = me?.primaryWallet;
  const short = addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : '…';

  async function copyAddress() {
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 h-9 px-2.5 rounded-md hover:bg-[color:var(--surface-hover)] transition-colors"
      >
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold"
          style={{
            background:
              'linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 60%, black) 100%)',
            color: 'var(--accent-fg)',
          }}
        >
          {addr ? addr.slice(0, 1).toUpperCase() : 'Q'}
        </div>
        {me ? (
          <span className="font-mono text-[12px] text-[color:var(--text-2)] hidden sm:inline">
            {short}
          </span>
        ) : (
          <Skeleton w={60} h={12} />
        )}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[color:var(--text-3)]">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute right-0 top-[calc(100%+8px)] w-[280px] z-50 glass-strong overflow-hidden fade-in"
          style={{ boxShadow: '0 12px 40px rgba(0,0,0,0.4)' }}
        >
          <div className="px-4 py-3 border-b border-[color:var(--border)]">
            <div className="text-[11px] text-[color:var(--text-3)] uppercase tracking-wider mb-1">
              Primary wallet
            </div>
            <button
              onClick={copyAddress}
              className="font-mono text-[12px] text-left w-full truncate hover:text-[color:var(--accent)] transition-colors"
              title="Copy address"
            >
              {addr ?? '…'}
            </button>
            {copied && (
              <div className="text-[10px] text-[color:var(--ok)] mt-1">Copied ✓</div>
            )}
          </div>
          <nav className="py-1">
            <MenuLink href="/dashboard" onClick={() => setOpen(false)}>Dashboard</MenuLink>
            <MenuLink href="/wallets" onClick={() => setOpen(false)}>Wallets</MenuLink>
            <MenuLink href="/analytics" onClick={() => setOpen(false)}>Analytics</MenuLink>
            <MenuLink href="/settings" onClick={() => setOpen(false)}>Settings</MenuLink>
          </nav>
          <div className="border-t border-[color:var(--border)] py-1">
            <button
              onClick={() => { setOpen(false); logout(); window.location.href = '/'; }}
              className="w-full text-left px-4 py-2 text-[13px] hover:bg-[color:var(--surface-hover)] transition-colors"
              style={{ color: 'var(--bad)' }}
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuLink({ href, onClick, children }: { href: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <a
      href={href}
      onClick={onClick}
      className="block px-4 py-2 text-[13px] hover:bg-[color:var(--surface-hover)] transition-colors"
    >
      {children}
    </a>
  );
}

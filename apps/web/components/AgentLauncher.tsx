'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import ChatPanel from './ChatPanel';

/**
 * AgentLauncher — global FAB that opens the real agent chat in a right-side drawer.
 * Never shown on marketing (/ , /login) or the full /chat route.
 * On lg+ screens the drawer pushes main content left (no disruption); on
 * smaller screens it overlays with a light backdrop.
 * Keyboard: ⌘/  or  Ctrl+/  toggles.  Esc closes.
 */

const LABEL_BY_ROUTE: Record<string, string> = {
  '/dashboard': 'Ask your agent',
  '/trade':     'Trade with agent',
  '/agents':    'Manage agents',
  '/tokens':    'Research a token',
  '/wallets':   'Ask about wallets',
  '/analytics': 'Ask about performance',
  '/social':    'Scout traders',
  '/settings':  'Adjust settings',
  '/design':    'Ask the design kit',
};

export default function AgentLauncher() {
  const pathname = usePathname() || '/';
  const [open, setOpen] = useState(false);

  const isMarketing = pathname === '/' || pathname.startsWith('/login');
  const isFullChat = pathname.startsWith('/chat');
  const hidden = isMarketing || isFullChat;

  // Auto-close whenever the route changes to the full-chat page
  // (or any page that hides the launcher).
  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  // Keyboard shortcut ⌘/ or Ctrl+/
  useEffect(() => {
    if (hidden) return;
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === '/') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden, open]);

  // Toggle the body attribute that pushes shell-main-col on large screens.
  useEffect(() => {
    const flag = open && !hidden;
    if (typeof document === 'undefined') return;
    if (flag) document.body.setAttribute('data-agent-open', '1');
    else document.body.removeAttribute('data-agent-open');
    return () => { document.body.removeAttribute('data-agent-open'); };
  }, [open, hidden]);

  if (hidden) return null;

  const label =
    LABEL_BY_ROUTE[Object.keys(LABEL_BY_ROUTE).find((p) => pathname.startsWith(p)) || ''] ||
    'Ask your agent';

  return (
    <>
      <button
        type="button"
        className="agent-fab"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={`${label}  ·  ⌘/`}
      >
        <span className="agent-fab-orb" aria-hidden />
        <span className="agent-fab-label-full">{label}</span>
        <span className="agent-fab-kbd" aria-hidden>⌘/</span>
      </button>

      {open && (
        <>
          {/* Backdrop only on small screens (desktop uses push) */}
          <div
            className="agent-drawer-backdrop"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <aside
            className="agent-drawer"
            role="dialog"
            aria-label="Agent chat"
          >
            <header className="agent-drawer-header">
              <span className="agent-fab-orb" aria-hidden style={{ width: 22, height: 22 }} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold tracking-tight">Agent</div>
                <div className="text-[11px] truncate" style={{ color: 'var(--text-3)' }}>
                  {label} · <span className="font-mono">{pathname}</span>
                </div>
              </div>
              <a
                href="/chat"
                className="btn-icon"
                title="Open full chat"
                aria-label="Open full chat"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h6v6" />
                  <path d="M10 14 21 3" />
                  <path d="M21 14v7h-7" />
                  <path d="M3 10v11h11" />
                </svg>
              </a>
              <button
                className="btn-icon"
                onClick={() => setOpen(false)}
                aria-label="Close agent"
                title="Close (Esc)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </header>
            <div className="agent-drawer-body">
              {/* The actual agent — same component as /chat, just stretched to drawer */}
              <ChatPanel />
            </div>
          </aside>
        </>
      )}
    </>
  );
}

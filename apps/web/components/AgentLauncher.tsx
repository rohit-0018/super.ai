'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import ChatPanel from './ChatPanel';

/**
 * AgentLauncher — draggable global FAB that opens the real agent chat in a right-side drawer.
 * Never shown on marketing (/ , /login) or the full /chat route.
 * Keyboard: ⌘/  or  Ctrl+/  toggles.  Esc closes.
 * FAB position persists in localStorage under key `agent-fab-pos`.
 */

const FAB_SIZE = 44;
const STORAGE_KEY = 'agent-fab-pos';

function getDefaultPos() {
  if (typeof window === 'undefined') return { x: 0, y: 0 };
  return { x: window.innerWidth - FAB_SIZE - 20, y: window.innerHeight - FAB_SIZE - 20 };
}

function loadPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p.x === 'number' && typeof p.y === 'number') return p;
  } catch {}
  return null;
}

function savePos(pos: { x: number; y: number }) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); } catch {}
}

export default function AgentLauncher() {
  const pathname = usePathname() || '/';
  const [open, setOpen] = useState(false);

  const isMarketing = pathname === '/' || pathname.startsWith('/login');
  const isFullChat = pathname.startsWith('/chat');
  const hidden = isMarketing || isFullChat;

  // FAB position state
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{
    startPx: number; startPy: number;
    startX: number; startY: number;
    moved: boolean;
  } | null>(null);

  // Load position from localStorage on mount
  useEffect(() => {
    const saved = loadPos();
    setPos(saved ?? getDefaultPos());
  }, []);

  // Auto-close whenever the route changes to the full-chat page
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

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (!pos) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startPx: e.clientX,
      startPy: e.clientY,
      startX: pos.x,
      startY: pos.y,
      moved: false,
    };
  }

  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startPx;
    const dy = e.clientY - dragRef.current.startPy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragRef.current.moved = true;
    const maxX = window.innerWidth - FAB_SIZE - 4;
    const maxY = window.innerHeight - FAB_SIZE - 4;
    const newPos = {
      x: Math.max(4, Math.min(maxX, dragRef.current.startX + dx)),
      y: Math.max(4, Math.min(maxY, dragRef.current.startY + dy)),
    };
    setPos(newPos);
  }

  function onPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    if (!dragRef.current) return;
    const wasDrag = dragRef.current.moved;
    if (pos) savePos(pos);
    dragRef.current = null;
    if (!wasDrag) setOpen(true);
  }

  if (hidden || pos === null) return null;

  return (
    <>
      <button
        type="button"
        className="agent-fab"
        style={{ left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        aria-label="Ask your agent"
        title="Ask your agent  ·  ⌘/"
      >
        {/* Lightning bolt SVG */}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden style={{ color: 'var(--accent)', flexShrink: 0 }}>
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold tracking-tight">Agent</div>
                <div className="text-[11px] truncate" style={{ color: 'var(--text-3)' }}>
                  Ask your agent · <span className="font-mono">{pathname}</span>
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
              <ChatPanel />
            </div>
          </aside>
        </>
      )}
    </>
  );
}

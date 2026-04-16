'use client';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import ChatPanel from './ChatPanel';

const HIDE_ON = ['/', '/login'];

export default function GlobalChatFab() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  if (HIDE_ON.includes(pathname)) return null;

  return (
    <div className="chat-fab-container">
      {open && (
        <div className="chat-fab-panel fade-in">
          <ChatPanel onClose={() => setOpen(false)} />
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        className={`chat-fab-btn ${open ? 'chat-fab-btn--active' : ''}`}
        title={open ? 'Close chat' : 'Chat with QWAI'}
      >
        {open ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        )}
        {!open && <span className="chat-fab-label">QWAI</span>}
      </button>
    </div>
  );
}

'use client';
import { useState } from 'react';
import { api } from '../lib/api';

interface Msg { role: 'user' | 'assistant'; content: string; }

export default function ChatPanel() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);

  async function send() {
    if (!input.trim()) return;
    const userMsg: Msg = { role: 'user', content: input };
    setMsgs((m) => [...m, userMsg, { role: 'assistant', content: '' }]);
    setInput('');
    setStreaming(true);
    try {
      const resp = await fetch((api.defaults.baseURL ?? '') + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(api.defaults.headers.common as any) },
        body: JSON.stringify({ content: userMsg.content }),
      });
      const reader = resp.body!.getReader();
      const dec = new TextDecoder();
      let acc = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const j = JSON.parse(line.slice(6));
              if (j.chunk) {
                acc += j.chunk;
                setMsgs((m) => {
                  const copy = [...m];
                  copy[copy.length - 1] = { role: 'assistant', content: acc };
                  return copy;
                });
              }
            } catch {}
          }
        }
      }
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="panel flex flex-col h-[460px]">
      <div className="flex items-center justify-between mb-4">
        <h3 className="section-title">QWAI chat</h3>
        <span className="chip">
          <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--ok)]" /> ready
        </span>
      </div>

      <div className="flex-1 overflow-auto space-y-5 pr-1 -mr-1">
        {msgs.length === 0 && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-sm">
              <div className="text-[13px] text-[color:var(--text-2)] mb-2">
                Ask anything about your trades, markets, or strategy.
              </div>
              <div className="text-[12px] text-[color:var(--text-3)] font-mono">
                &ldquo;Buy $200 of SOL if it dips under $140&rdquo;
              </div>
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className="text-[13px]">
            <div className="stat-label mb-1.5">{m.role === 'user' ? 'You' : 'QWAI'}</div>
            <div
              className={`whitespace-pre-wrap leading-relaxed ${
                m.role === 'user' ? 'text-text' : 'text-[color:var(--text-2)]'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2 mt-4 pt-4 border-t border-border">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Message QWAI…"
          className="input"
        />
        <button onClick={send} disabled={streaming || !input.trim()} className="btn btn-primary">
          Send
        </button>
      </div>
    </div>
  );
}

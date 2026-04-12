'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  pending?: boolean;
  error?: boolean;
}

const SUGGESTIONS = [
  'Buy $200 of SOL if it dips under $140',
  'What happened to my PnL today?',
  'Analyze contract Es9vMFrz…USDC',
  'Set a 5% trailing stop on my open positions',
];

function formatTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Minimal markdown: **bold**, `inline code`, ```fenced``` blocks, line breaks. */
function renderContent(text: string): React.ReactNode {
  if (!text) return null;
  const parts: React.ReactNode[] = [];
  const fenceRe = /```([\s\S]*?)```/g;
  let lastIdx = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(renderInline(text.slice(lastIdx, m.index), key++));
    parts.push(<pre key={`p${key++}`}>{m[1].replace(/^\n|\n$/g, '')}</pre>);
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push(renderInline(text.slice(lastIdx), key++));
  return parts;
}

function renderInline(text: string, key: number): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(<span key={`t${k++}`}>{text.slice(last, m.index)}</span>);
    const tok = m[0];
    if (tok.startsWith('**')) nodes.push(<strong key={`b${k++}`}>{tok.slice(2, -2)}</strong>);
    else nodes.push(<code key={`c${k++}`}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(<span key={`t${k++}`}>{text.slice(last)}</span>);
  return <span key={`frag${key}`}>{nodes}</span>;
}

export default function ChatPanel() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get<Msg[]>('/chat/history');
        if (!cancelled && Array.isArray(data)) setMsgs(data);
      } catch {
        // silent — fresh conversation
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs, streaming]);

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  };

  useEffect(autoGrow, [input]);

  async function send() {
    const content = input.trim();
    if (!content || streaming) return;

    const now = new Date().toISOString();
    const userMsg: Msg = { role: 'user', content, createdAt: now };
    const placeholder: Msg = { role: 'assistant', content: '', createdAt: now, pending: true };
    setMsgs((m) => [...m, userMsg, placeholder]);
    setInput('');
    setStreaming(true);
    setError(null);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const resp = await fetch((api.defaults.baseURL ?? '') + '/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(api.defaults.headers.common as Record<string, string>),
        },
        body: JSON.stringify({ content }),
        signal: ac.signal,
      });
      if (!resp.ok || !resp.body) {
        throw new Error(resp.status === 401 ? 'Your session expired. Please sign in again.' : `HTTP ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let acc = '';
      let buf = '';
      let streamError: string | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split(/\n\n/);
        buf = events.pop() ?? '';
        for (const ev of events) {
          let eventType = 'message';
          let dataPayload = '';
          for (const line of ev.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataPayload += line.slice(6);
          }
          if (!dataPayload) continue;
          if (eventType === 'error') {
            try { streamError = JSON.parse(dataPayload).message ?? 'Stream error'; }
            catch { streamError = dataPayload; }
            continue;
          }
          if (eventType === 'end') continue;
          try {
            const j = JSON.parse(dataPayload);
            if (j.chunk) {
              acc += j.chunk;
              setMsgs((m) => {
                const copy = [...m];
                copy[copy.length - 1] = { role: 'assistant', content: acc, createdAt: now, pending: false };
                return copy;
              });
            }
          } catch {
            // skip malformed lines
          }
        }
      }
      if (streamError) throw new Error(streamError);
      setMsgs((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last && last.role === 'assistant') copy[copy.length - 1] = { ...last, pending: false };
        return copy;
      });
    } catch (e: any) {
      if (ac.signal.aborted) return;
      setError(e?.message ?? 'Chat failed');
      setMsgs((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last && last.role === 'assistant') {
          copy[copy.length - 1] = {
            role: 'assistant',
            content: e?.message ?? 'Something went wrong.',
            createdAt: now,
            error: true,
          };
        }
        return copy;
      });
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  function clearChat() {
    setMsgs([]);
    setError(null);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const isEmpty = useMemo(() => !loadingHistory && msgs.length === 0, [loadingHistory, msgs.length]);

  return (
    <div className="glass glass-sheen flex flex-col h-[560px] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-[color:var(--border)]">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center font-semibold text-[13px] shrink-0"
            style={{
              background:
                'linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 70%, black) 100%)',
              color: 'var(--accent-fg)',
              boxShadow: '0 2px 8px var(--ring)',
            }}
          >
            Q
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-semibold truncate">QWAI</div>
            <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--text-3)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--ok)]" />
              {streaming ? 'thinking…' : 'online'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {msgs.length > 0 && (
            <button
              onClick={clearChat}
              disabled={streaming}
              className="btn btn-ghost btn-sm"
              title="Clear conversation"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4"
        style={{
          background:
            'radial-gradient(1100px 500px at 50% -10%, color-mix(in srgb, var(--accent) 4%, transparent) 0%, transparent 60%)',
        }}
      >
        {loadingHistory ? (
          <div className="h-full flex items-center justify-center">
            <div className="typing-dots"><span /><span /><span /></div>
          </div>
        ) : isEmpty ? (
          <div className="h-full flex flex-col items-center justify-center gap-5 text-center px-4">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center text-[22px] font-semibold"
              style={{
                background:
                  'linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 60%, black) 100%)',
                color: 'var(--accent-fg)',
                boxShadow: '0 8px 24px var(--ring)',
              }}
            >
              Q
            </div>
            <div>
              <div className="text-[15px] font-semibold mb-1">How can I help you trade?</div>
              <div className="text-[12px] text-[color:var(--text-3)]">
                Ask about strategy, positions, or paste a contract to analyze.
              </div>
            </div>
            <div className="flex flex-wrap gap-2 justify-center max-w-md">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="suggest-chip" onClick={() => { setInput(s); taRef.current?.focus(); }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {msgs.map((m, i) => {
              const prev = msgs[i - 1];
              const showHeader = !prev || prev.role !== m.role;
              const next = msgs[i + 1];
              const isLastInGroup = !next || next.role !== m.role;
              return (
                <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                  {showHeader && (
                    <div className="msg-meta mb-1">
                      {m.role === 'user' ? 'You' : 'QWAI'}
                      {m.createdAt ? ` · ${formatTime(m.createdAt)}` : ''}
                    </div>
                  )}
                  <div
                    className={`bubble ${m.role === 'user' ? 'bubble-user' : 'bubble-assistant'} ${
                      m.error ? 'border-[color:var(--bad)] text-[color:var(--bad)]' : ''
                    }`}
                    style={!isLastInGroup ? { marginBottom: 2 } : undefined}
                  >
                    {m.pending && !m.content ? (
                      <div className="typing-dots"><span /><span /><span /></div>
                    ) : (
                      renderContent(m.content)
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <div className="px-5 py-2 text-[12px] text-[color:var(--bad)] border-t border-[color:var(--border)] bg-[color:color-mix(in_srgb,var(--bad)_8%,transparent)]">
          {error}
        </div>
      )}

      {/* Composer */}
      <div className="px-3 pb-3 pt-2 border-t border-[color:var(--border)]">
        <div
          className="flex items-end gap-2 p-2 rounded-xl"
          style={{
            background: 'color-mix(in srgb, var(--surface-2) 70%, transparent)',
            border: '1px solid color-mix(in srgb, var(--border-2) 70%, transparent)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Message QWAI…  (Enter to send, Shift+Enter for newline)"
            rows={1}
            className="flex-1 bg-transparent outline-none resize-none text-[13.5px] leading-relaxed text-text placeholder:text-[color:var(--text-3)] py-1.5 px-2"
            style={{ maxHeight: 140 }}
            disabled={streaming}
          />
          {streaming ? (
            <button onClick={stop} className="btn btn-sm" title="Stop generating">
              Stop
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!input.trim()}
              className="btn btn-primary btn-sm"
              title="Send (Enter)"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

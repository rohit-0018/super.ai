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
    <div className="panel flex flex-col h-[420px]">
      <h3 className="font-bold mb-2">QWAI Chat</h3>
      <div className="flex-1 overflow-auto space-y-2 text-sm">
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-accent' : 'opacity-90'}>
            <span className="opacity-50 mr-2">{m.role === 'user' ? 'you' : 'qwai'}</span>
            {m.content}
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Buy $200 of SOL..."
          className="flex-1 bg-bg border border-[#1c2540] rounded px-2 py-1"
        />
        <button onClick={send} disabled={streaming} className="bg-accent text-black px-3 rounded font-bold">Send</button>
      </div>
    </div>
  );
}

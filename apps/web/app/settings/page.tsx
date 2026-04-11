'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth-store';

export default function Settings() {
  const { logout } = useAuth();
  const [g, setG] = useState<any>(null);
  const [paper, setPaper] = useState(false);
  const [tgCode, setTgCode] = useState<string | null>(null);
  const [tgExpires, setTgExpires] = useState<string | null>(null);

  useEffect(() => {
    api.get('/guardrails').then((r) => setG(r.data)).catch(() => setG({}));
    api.get('/me').then((r) => setPaper(!!r.data?.paperMode)).catch(() => {});
  }, []);

  async function save() {
    await api.post('/guardrails', g);
    alert('Saved');
  }

  async function killSwitch() {
    if (!confirm('Engage kill switch? All agents will be paused.')) return;
    await api.post('/guardrails/kill', {});
    setG({ ...g, killSwitch: true });
  }

  async function togglePaper() {
    const next = !paper;
    await api.post('/me/paper-mode', { paperMode: next });
    setPaper(next);
  }

  async function linkTelegram() {
    const { data } = await api.post('/auth/telegram/code', {});
    setTgCode(data.code);
    setTgExpires(new Date(data.expiresAt).toLocaleTimeString());
  }

  if (!g) {
    return <p className="text-[13px] text-[color:var(--text-3)]">Loading…</p>;
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
        <p className="text-[13px] text-[color:var(--text-2)] mt-1">
          Guardrails, trading mode, and account.
        </p>
      </header>

      <div className="panel">
        <h2 className="section-title mb-5">Guardrails</h2>
        <div className="space-y-4">
          <div>
            <label className="label">Per-trade limit (USD)</label>
            <input
              type="number"
              value={g.perTradeUsd ?? 0}
              onChange={(e) => setG({ ...g, perTradeUsd: +e.target.value })}
              className="input font-mono max-w-xs"
            />
          </div>
          <div>
            <label className="label">Daily limit (USD)</label>
            <input
              type="number"
              value={g.dailyUsd ?? 0}
              onChange={(e) => setG({ ...g, dailyUsd: +e.target.value })}
              className="input font-mono max-w-xs"
            />
          </div>
          <div>
            <label className="label">Max slippage (bps)</label>
            <input
              type="number"
              value={g.maxSlippageBps ?? 0}
              onChange={(e) => setG({ ...g, maxSlippageBps: +e.target.value })}
              className="input font-mono max-w-xs"
            />
          </div>
          <div className="flex gap-2 pt-2">
            <button onClick={save} className="btn btn-primary">Save</button>
            <button
              onClick={killSwitch}
              className="btn"
              style={{ color: 'var(--bad)', borderColor: 'var(--bad)' }}
            >
              Engage kill switch
            </button>
          </div>
          {g.killSwitch && (
            <p className="text-[13px]" style={{ color: 'var(--bad)' }}>
              Kill switch is ENGAGED.
            </p>
          )}
        </div>
      </div>

      <div className="panel">
        <h2 className="section-title mb-5">Trading mode</h2>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={paper}
            onChange={togglePaper}
            className="accent-[color:var(--accent)]"
          />
          <span className="text-[13px]">Paper trading mode (no live broadcast)</span>
        </label>
      </div>

      <div className="panel">
        <h2 className="section-title mb-2">Link Telegram</h2>
        <p className="text-[13px] text-[color:var(--text-2)] mb-4">
          Generate a one-time code, then send <code className="font-mono text-[color:var(--text)]">/link &lt;code&gt;</code> to the QWAI bot.
        </p>
        <button onClick={linkTelegram} className="btn btn-primary">
          Generate code
        </button>
        {tgCode && (
          <div className="mt-4 text-[13px] space-y-1">
            <div>
              Send this to the bot:{' '}
              <code className="font-mono text-[15px] text-[color:var(--accent)]">/link {tgCode}</code>
            </div>
            <div className="text-[color:var(--text-3)]">Expires at {tgExpires}</div>
          </div>
        )}
      </div>

      <div className="panel">
        <button onClick={logout} className="btn btn-ghost btn-sm">
          Log out
        </button>
      </div>
    </div>
  );
}

'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useApi, invalidate } from '../../lib/useApi';
import { useAuth } from '../../lib/auth-store';
import { Skeleton, Spinner } from '../../components/ui/Skeleton';

interface Me {
  paperMode: boolean;
  notificationPrefs?: {
    telegram?: boolean;
    email?: string | null;
    discordWebhook?: string | null;
  };
}

export default function Settings() {
  const { logout } = useAuth();
  const { data: g, loading: gLoading } = useApi<any>('/guardrails');
  const { data: me, loading: meLoading } = useApi<Me>('/me');
  const [localG, setLocalG] = useState<any>(null);
  const [paper, setPaper] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tgCode, setTgCode] = useState<string | null>(null);
  const [tgExpires, setTgExpires] = useState<string | null>(null);

  // Notification prefs
  const [tgEnabled, setTgEnabled] = useState(true);
  const [email, setEmail] = useState('');
  const [discordUrl, setDiscordUrl] = useState('');
  const [prefsSaving, setPrefsSaving] = useState(false);
  const [prefsMsg, setPrefsMsg] = useState<string | null>(null);

  useEffect(() => {
    if (g && !localG) setLocalG(g);
  }, [g, localG]);

  useEffect(() => {
    if (me) {
      setPaper(!!me.paperMode);
      setTgEnabled(me.notificationPrefs?.telegram !== false);
      setEmail(me.notificationPrefs?.email ?? '');
      setDiscordUrl(me.notificationPrefs?.discordWebhook ?? '');
    }
  }, [me]);

  async function save() {
    setSaving(true);
    try {
      await api.post('/guardrails', localG);
      invalidate('/guardrails');
    } finally {
      setSaving(false);
    }
  }

  async function killSwitch() {
    if (!confirm('Engage kill switch? All agents will be paused.')) return;
    await api.post('/guardrails/kill', {});
    invalidate('/guardrails');
  }

  async function togglePaper() {
    const next = !paper;
    setPaper(next);
    await api.post('/me/paper-mode', { paperMode: next });
    invalidate('/me');
  }

  async function linkTelegram() {
    const { data } = await api.post('/auth/telegram/code', {});
    setTgCode(data.code);
    setTgExpires(new Date(data.expiresAt).toLocaleTimeString());
  }

  async function saveNotifPrefs() {
    setPrefsSaving(true);
    setPrefsMsg(null);
    try {
      await api.post('/me/notification-prefs', {
        telegram: tgEnabled,
        email: email.trim() || null,
        discordWebhook: discordUrl.trim() || null,
      });
      setPrefsMsg('Preferences saved');
      invalidate('/me');
    } catch (e: any) {
      setPrefsMsg(e?.message ?? 'Failed to save');
    } finally {
      setPrefsSaving(false);
    }
  }

  const loading = gLoading || meLoading;

  return (
    <div className="space-y-6 max-w-2xl">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
        <p className="text-[13px] text-[color:var(--text-2)] mt-1">
          Guardrails, trading mode, notifications, and account.
        </p>
      </header>

      {/* Guardrails */}
      <div className="panel">
        <h2 className="section-title mb-5">Guardrails</h2>
        {loading && !localG ? (
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i}><Skeleton w={120} h={12} className="mb-2" /><Skeleton w={200} h={36} rounded="md" /></div>
            ))}
          </div>
        ) : localG ? (
          <div className="space-y-4">
            <div>
              <label className="label">Per-trade limit (USD)</label>
              <input type="number" value={localG.perTradeUsd ?? 0} onChange={(e) => setLocalG({ ...localG, perTradeUsd: +e.target.value })} className="input font-mono max-w-xs" />
            </div>
            <div>
              <label className="label">Daily limit (USD)</label>
              <input type="number" value={localG.dailyUsd ?? 0} onChange={(e) => setLocalG({ ...localG, dailyUsd: +e.target.value })} className="input font-mono max-w-xs" />
            </div>
            <div>
              <label className="label">Max slippage (bps)</label>
              <input type="number" value={localG.maxSlippageBps ?? 0} onChange={(e) => setLocalG({ ...localG, maxSlippageBps: +e.target.value })} className="input font-mono max-w-xs" />
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={save} disabled={saving} className="btn btn-primary">
                {saving ? <Spinner size={12} /> : 'Save'}
              </button>
              <button onClick={killSwitch} className="btn" style={{ color: 'var(--bad)', borderColor: 'var(--bad)' }}>
                Engage kill switch
              </button>
            </div>
            {localG.killSwitch && (
              <p className="text-[13px]" style={{ color: 'var(--bad)' }}>Kill switch is ENGAGED.</p>
            )}
          </div>
        ) : null}
      </div>

      {/* Trading mode */}
      <div className="panel">
        <h2 className="section-title mb-5">Trading mode</h2>
        {meLoading ? (
          <Skeleton w={250} h={20} />
        ) : (
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={paper} onChange={togglePaper} className="accent-[color:var(--accent)]" />
            <span className="text-[13px]">Paper trading mode (no live broadcast)</span>
          </label>
        )}
      </div>

      {/* Notification preferences (K1-K4) */}
      <div className="panel">
        <h2 className="section-title mb-2">Notification preferences</h2>
        <p className="text-[13px] text-[color:var(--text-2)] mb-5">
          Choose how you receive alerts, briefings, and trade confirmations.
        </p>
        <div className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={tgEnabled} onChange={(e) => setTgEnabled(e.target.checked)} className="accent-[color:var(--accent)]" />
            <div>
              <div className="text-[13px] font-medium">Telegram push</div>
              <div className="text-[11px] text-[color:var(--text-3)]">Alerts, briefings, and trade confirmations to your linked Telegram</div>
            </div>
          </label>
          <div>
            <label className="label">Email notifications</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com (optional)"
              className="input max-w-sm"
            />
          </div>
          <div>
            <label className="label">Discord webhook URL</label>
            <input
              type="url"
              value={discordUrl}
              onChange={(e) => setDiscordUrl(e.target.value)}
              placeholder="https://discord.com/api/webhooks/... (optional)"
              className="input font-mono max-w-sm"
            />
          </div>
          <div className="flex items-center gap-3">
            <button onClick={saveNotifPrefs} disabled={prefsSaving} className="btn btn-primary">
              {prefsSaving ? <Spinner size={12} /> : 'Save preferences'}
            </button>
            {prefsMsg && (
              <span className="text-[12px]" style={{ color: prefsMsg.includes('saved') ? 'var(--ok)' : 'var(--bad)' }}>
                {prefsMsg}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Telegram link */}
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
              Send this to the bot: <code className="font-mono text-[15px] text-[color:var(--accent)]">/link {tgCode}</code>
            </div>
            <div className="text-[color:var(--text-3)]">Expires at {tgExpires}</div>
          </div>
        )}
      </div>

      {/* Account */}
      <div className="panel">
        <h2 className="section-title mb-3">Account</h2>
        <button onClick={logout} className="btn" style={{ color: 'var(--bad)', borderColor: 'var(--bad)' }}>
          Sign out
        </button>
      </div>
    </div>
  );
}

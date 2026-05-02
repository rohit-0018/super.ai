'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useApi, invalidate } from '../../lib/useApi';
import { useAuth } from '../../lib/auth-store';
import { Skeleton, Spinner } from '../../components/ui/Skeleton';
import IntentRulesPanel from '../../components/IntentRulesPanel';
import ConvictionWeightsPanel from '../../components/ConvictionWeightsPanel';
import { useBannerSettings } from '../../lib/useBannerSettings';

type AutonomyLevel = 'MANUAL' | 'GUIDED' | 'SEMI_AUTO' | 'FULL_AUTO';
type ApprovalChannel = 'WEB' | 'TELEGRAM';

interface LearningConfig {
  enabled: boolean;
  autonomyLevel: AutonomyLevel;
  maxTradeUsd: number;
  dailyLimit: number;
  approvalRequired: boolean;
  approvalTimeoutMin: number;
  approvalChannels: ApprovalChannel[];
  onTimeout: 'reject' | 'execute';
}

interface Me {
  paperMode: boolean;
  notificationPrefs?: {
    telegram?: boolean;
    email?: string | null;
    discordWebhook?: string | null;
  };
  learningConfig?: LearningConfig | null;
}

interface Strategy {
  id: string;
  name: string;
  source: 'LEARNED' | 'USER_DEFINED';
  definition: { prompt?: string; trigger?: Record<string, unknown>; notes?: string };
  enabled: boolean;
  score?: number | null;
  lastRationale?: string | null;
  lastScoredAt?: string | null;
  createdAt: string;
}

const AUTONOMY_TIERS: { value: AutonomyLevel; label: string; hint: string }[] = [
  { value: 'MANUAL', label: 'Manual', hint: 'Learns only. No autonomous trades.' },
  { value: 'GUIDED', label: 'Guided', hint: 'Suggests trades, you execute.' },
  { value: 'SEMI_AUTO', label: 'Semi-Auto', hint: 'Queues trades for your approval within the timeout.' },
  { value: 'FULL_AUTO', label: 'Full Auto', hint: 'Executes inside guardrails. Paper mode + kill switch still apply.' },
];

export default function Settings() {
  const { logout } = useAuth();
  const { settings: banner, setSettings: setBanner } = useBannerSettings();
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

  // Learning & Autonomy
  const { data: lc } = useApi<LearningConfig>('/me/learning-config');
  const [learn, setLearn] = useState<LearningConfig | null>(null);
  const [learnSaving, setLearnSaving] = useState(false);
  const [learnMsg, setLearnMsg] = useState<string | null>(null);
  useEffect(() => { if (lc && !learn) setLearn(lc); }, [lc, learn]);

  function toggleChannel(ch: ApprovalChannel) {
    if (!learn) return;
    const has = learn.approvalChannels.includes(ch);
    setLearn({
      ...learn,
      approvalChannels: has ? learn.approvalChannels.filter((c) => c !== ch) : [...learn.approvalChannels, ch],
    });
  }

  // Strategies
  const { data: strategies } = useApi<Strategy[]>('/strategies');
  const [draft, setDraft] = useState<{ name: string; prompt: string; notes: string }>({ name: '', prompt: '', notes: '' });
  const [stratBusy, setStratBusy] = useState(false);
  const [stratMsg, setStratMsg] = useState<string | null>(null);

  async function addStrategy() {
    if (!draft.name.trim() || !draft.prompt.trim()) { setStratMsg('Name and prompt are required'); return; }
    setStratBusy(true); setStratMsg(null);
    try {
      await api.post('/strategies', {
        name: draft.name.trim(),
        definition: { prompt: draft.prompt.trim(), notes: draft.notes.trim() || undefined },
        enabled: false,
      });
      setDraft({ name: '', prompt: '', notes: '' });
      invalidate('/strategies');
    } catch (e: any) {
      setStratMsg(e?.message ?? 'Failed to add');
    } finally {
      setStratBusy(false);
    }
  }

  async function toggleStrategy(s: Strategy) {
    await api.put(`/strategies/${s.id}`, { enabled: !s.enabled });
    invalidate('/strategies');
  }

  async function deleteStrategy(s: Strategy) {
    if (!confirm(`Delete strategy "${s.name}"?`)) return;
    await api.delete(`/strategies/${s.id}`);
    invalidate('/strategies');
  }

  async function saveLearning() {
    if (!learn) return;
    setLearnSaving(true);
    setLearnMsg(null);
    try {
      await api.put('/me/learning-config', learn);
      invalidate('/me/learning-config');
      invalidate('/me');
      setLearnMsg('Saved');
    } catch (e: any) {
      setLearnMsg(e?.message ?? 'Failed to save');
    } finally {
      setLearnSaving(false);
    }
  }

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
    <div className="page page-narrow space-y-4">
      <header>
        <div className="section-eyebrow">Settings</div>
        <h1 className="page-title">Preferences</h1>
        <p className="page-subtitle">Guardrails, trading mode, notifications, and account.</p>
      </header>

      {/* ── Signal Banner ─────────────────────────────────────────────────── */}
      {process.env.NEXT_PUBLIC_SIGNAL_BANNER_VISIBLE !== 'false' && (
        <div className="panel">
          <h2 className="section-title mb-1" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>🚨</span> Signal Banner
          </h2>
          <p className="page-subtitle mb-4">
            When the AI pipeline finds a strong signal, a banner slides in below the topbar with one-click buy and exit targets (T1 / T2 / stop-loss).
          </p>

          {/* Enable / disable */}
          <div className="flex items-center justify-between mb-4 pb-4" style={{ borderBottom: '1px solid var(--border)' }}>
            <div>
              <div className="text-[13px] font-medium">Enable signal banner</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>Show the banner when a hot token hits the signal threshold</div>
            </div>
            <ToggleSwitch on={banner.enabled} color="var(--ok)" onToggle={() => setBanner({ enabled: !banner.enabled })} />
          </div>

          <div className="grid grid-cols-2 gap-x-8 gap-y-4" style={{ opacity: banner.enabled ? 1 : 0.4, pointerEvents: banner.enabled ? 'auto' : 'none' }}>
            {/* Signal threshold */}
            <div>
              <label className="label">Signal threshold (min score)</label>
              <div className="flex gap-2">
                {[62, 70, 78, 85].map((v) => (
                  <button
                    key={v}
                    onClick={() => setBanner({ minScore: v })}
                    className="btn btn-sm"
                    style={banner.minScore === v ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : {}}
                  >
                    {v === 62 ? 'BUY+' : v === 78 ? 'STRONG' : v + '+'}
                  </button>
                ))}
              </div>
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-3)' }}>
                {banner.minScore >= 78 ? 'Only STRONG BUY signals' : 'BUY + STRONG BUY signals'}
              </p>
            </div>

            {/* Default position size */}
            <div>
              <label className="label">Manual buy size (USD)</label>
              <div className="flex gap-2 flex-wrap">
                {[5, 10, 25, 50, 100].map((v) => (
                  <button
                    key={v}
                    onClick={() => setBanner({ positionSizeUsd: v })}
                    className="btn btn-sm"
                    style={banner.positionSizeUsd === v ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : {}}
                  >
                    ${v}
                  </button>
                ))}
              </div>
            </div>

            {/* Auto-dismiss */}
            <div>
              <label className="label">Auto-dismiss after</label>
              <div className="flex gap-2">
                {[0, 20, 45, 90].map((v) => (
                  <button
                    key={v}
                    onClick={() => setBanner({ dismissAfterSec: v })}
                    className="btn btn-sm"
                    style={banner.dismissAfterSec === v ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : {}}
                  >
                    {v === 0 ? 'Manual' : `${v}s`}
                  </button>
                ))}
              </div>
            </div>

            {/* Sound */}
            <div>
              <label className="label">Sound alert</label>
              <div className="flex gap-2">
                {[true, false].map((v) => (
                  <button
                    key={String(v)}
                    onClick={() => setBanner({ sound: v })}
                    className="btn btn-sm"
                    style={banner.sound === v ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : {}}
                  >
                    {v ? 'On' : 'Off'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Signal Trade (Auto) ───────────────────────────────────────────── */}
      {process.env.NEXT_PUBLIC_SIGNAL_TRADE_VISIBLE !== 'false' && (
        <div className="panel" style={{ borderColor: banner.autoBuy ? 'color-mix(in srgb, var(--warn) 40%, var(--border))' : undefined }}>
          <h2 className="section-title mb-1" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>⚡</span> Signal Trade
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', padding: '2px 7px', borderRadius: 4, background: 'color-mix(in srgb, var(--warn) 15%, transparent)', color: 'var(--warn)', border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)' }}>
              AUTO MODE
            </span>
          </h2>
          <p className="page-subtitle mb-4">
            Fast-lane: the AI pipeline buys automatically the instant a strong signal fires — no banner interaction required. Configure position size and exit rules here.
          </p>

          {/* Auto-buy master toggle */}
          <div className="flex items-center justify-between mb-4 pb-4" style={{ borderBottom: '1px solid var(--border)' }}>
            <div>
              <div className="text-[13px] font-medium" style={{ color: banner.autoBuy ? 'var(--warn)' : undefined }}>
                Auto-buy on signal
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>
                {banner.autoBuy
                  ? 'ACTIVE — buys execute automatically when score ≥ threshold'
                  : 'Off — signals show a banner only, no automatic execution'}
              </div>
            </div>
            <ToggleSwitch on={banner.autoBuy} color="var(--warn)" onToggle={() => setBanner({ autoBuy: !banner.autoBuy, autoSell: banner.autoBuy ? false : banner.autoSell })} />
          </div>

          <div className="grid grid-cols-2 gap-x-8 gap-y-4" style={{ opacity: banner.autoBuy ? 1 : 0.4, pointerEvents: banner.autoBuy ? 'auto' : 'none' }}>
            {/* Auto position size — separate from manual banner size */}
            <div>
              <label className="label">Auto-buy size (USD)</label>
              <div className="flex gap-2 flex-wrap">
                {[5, 10, 25, 50, 100].map((v) => (
                  <button
                    key={v}
                    onClick={() => setBanner({ positionSizeUsd: v })}
                    className="btn btn-sm"
                    style={banner.positionSizeUsd === v ? { background: 'var(--warn)', color: '#fff', borderColor: 'var(--warn)' } : {}}
                  >
                    ${v}
                  </button>
                ))}
              </div>
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-3)' }}>Shared with banner buy size</p>
            </div>

            {/* Min score for auto trigger */}
            <div>
              <label className="label">Auto-trigger min score</label>
              <div className="flex gap-2">
                {[70, 78, 85, 90].map((v) => (
                  <button
                    key={v}
                    onClick={() => setBanner({ minScore: v })}
                    className="btn btn-sm"
                    style={banner.minScore === v ? { background: 'var(--warn)', color: '#fff', borderColor: 'var(--warn)' } : {}}
                  >
                    {v}+
                  </button>
                ))}
              </div>
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-3)' }}>Higher = fewer but stronger signals</p>
            </div>

            {/* Auto-sell at T1 */}
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="flex items-center justify-between">
                <div>
                  <label className="label" style={{ marginBottom: 2 }}>Auto-sell at T1</label>
                  <div className="text-[11px]" style={{ color: 'var(--text-3)' }}>
                    {banner.autoSell ? 'Places a limit sell order at T1 immediately after buy fills' : 'Off — exit manually or set a stop-loss in guardrails'}
                  </div>
                </div>
                <ToggleSwitch on={banner.autoSell} color="var(--accent)" onToggle={() => setBanner({ autoSell: !banner.autoSell })} />
              </div>
            </div>
          </div>

          {banner.autoBuy && (
            <div className="mt-4 p-3 rounded-lg text-[11px]"
              style={{ background: 'color-mix(in srgb, var(--warn) 8%, var(--surface-2))', border: '1px solid color-mix(in srgb, var(--warn) 25%, var(--border))', color: 'var(--warn)' }}>
              ⚠ Auto mode uses real funds without confirmation. Paper mode still applies — flip it off only for live trading. Per-trade and daily limits in Guardrails cap the downside.
            </div>
          )}
        </div>
      )}

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
              <input type="number" value={localG.perTradeUsd ?? 0} onChange={(e) => setLocalG({ ...localG, perTradeUsd: +e.target.value })} className="input font-mono w-full sm:max-w-xs" />
            </div>
            <div>
              <label className="label">Daily limit (USD)</label>
              <input type="number" value={localG.dailyUsd ?? 0} onChange={(e) => setLocalG({ ...localG, dailyUsd: +e.target.value })} className="input font-mono w-full sm:max-w-xs" />
            </div>
            <div>
              <label className="label">Max slippage (bps)</label>
              <input type="number" value={localG.maxSlippageBps ?? 0} onChange={(e) => setLocalG({ ...localG, maxSlippageBps: +e.target.value })} className="input font-mono w-full sm:max-w-xs" />
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <button onClick={save} disabled={saving} className="btn btn-primary flex-1 sm:flex-none">
                {saving ? <Spinner size={12} /> : 'Save'}
              </button>
              <button onClick={killSwitch} className="btn flex-1 sm:flex-none" style={{ color: 'var(--bad)', borderColor: 'var(--bad)' }}>
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

      {/* Learning & Autonomy */}
      <div className="panel">
        <h2 className="section-title mb-2">Learning & Autonomy</h2>
        <p className="text-[13px] text-[color:var(--text-2)] mb-5">
          The agent learns your style from every trade and can act on its own within your guardrails. Paper mode and the kill switch always apply.
        </p>
        {!learn ? (
          <Skeleton w={320} h={24} />
        ) : (
          <div className="space-y-5">
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={learn.enabled} onChange={(e) => setLearn({ ...learn, enabled: e.target.checked })} className="accent-[color:var(--accent)]" />
              <div>
                <div className="text-[13px] font-medium">Enable progressive learning</div>
                <div className="text-[11px] text-[color:var(--text-3)]">Builds your Trading DNA from behavior. Disable to pause all learning and autonomy.</div>
              </div>
            </label>

            <div>
              <label className="label mb-2">Autonomy level</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {AUTONOMY_TIERS.map((t) => {
                  const active = learn.autonomyLevel === t.value;
                  return (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setLearn({ ...learn, autonomyLevel: t.value })}
                      disabled={!learn.enabled && t.value !== 'MANUAL'}
                      className="panel text-left p-3"
                      style={{
                        borderColor: active ? 'var(--accent)' : undefined,
                        opacity: !learn.enabled && t.value !== 'MANUAL' ? 0.5 : 1,
                      }}
                    >
                      <div className="text-[13px] font-medium">{t.label}</div>
                      <div className="text-[11px] text-[color:var(--text-3)] mt-1">{t.hint}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="label">Max per autonomous trade (USD)</label>
                <input type="number" min={0} value={learn.maxTradeUsd} onChange={(e) => setLearn({ ...learn, maxTradeUsd: +e.target.value })} className="input font-mono" />
              </div>
              <div>
                <label className="label">Daily autonomous trades</label>
                <input type="number" min={0} value={learn.dailyLimit} onChange={(e) => setLearn({ ...learn, dailyLimit: +e.target.value })} className="input font-mono" />
              </div>
            </div>

            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={learn.approvalRequired} onChange={(e) => setLearn({ ...learn, approvalRequired: e.target.checked })} className="accent-[color:var(--accent)]" />
              <div>
                <div className="text-[13px] font-medium">Require approval before each autonomous trade</div>
                <div className="text-[11px] text-[color:var(--text-3)]">Off = Full Auto execution within guardrails.</div>
              </div>
            </label>

            {learn.approvalRequired && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="label">Approval timeout (min)</label>
                  <input type="number" min={1} max={1440} value={learn.approvalTimeoutMin} onChange={(e) => setLearn({ ...learn, approvalTimeoutMin: +e.target.value })} className="input font-mono" />
                </div>
                <div>
                  <label className="label">On timeout</label>
                  <select
                    value={learn.onTimeout}
                    onChange={(e) => setLearn({ ...learn, onTimeout: e.target.value as 'reject' | 'execute' })}
                    className="input"
                  >
                    <option value="reject">Reject trade</option>
                    <option value="execute">Execute anyway</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="label mb-2">Approval channels</label>
                  <div className="flex flex-wrap gap-4">
                    {(['WEB', 'TELEGRAM'] as ApprovalChannel[]).map((ch) => (
                      <label key={ch} className="flex items-center gap-2 cursor-pointer min-h-[44px]">
                        <input type="checkbox" checked={learn.approvalChannels.includes(ch)} onChange={() => toggleChannel(ch)} className="accent-[color:var(--accent)]" />
                        <span className="text-[13px]">{ch === 'WEB' ? 'Web (dashboard card)' : 'Telegram (inline buttons)'}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center gap-3 pt-1">
              <button onClick={saveLearning} disabled={learnSaving} className="btn btn-primary">
                {learnSaving ? <Spinner size={12} /> : 'Save learning settings'}
              </button>
              {learnMsg && (
                <span className="text-[12px]" style={{ color: learnMsg === 'Saved' ? 'var(--ok)' : 'var(--bad)' }}>
                  {learnMsg}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Strategy editor */}
      <div className="panel">
        <h2 className="section-title mb-2">Strategies</h2>
        <p className="text-[13px] text-[color:var(--text-2)] mb-5">
          Write strategies in plain English. Each is graded against your recent trades and can drive autonomous execution when enabled.
        </p>
        <div className="space-y-4">
          <div className="space-y-3">
            <input
              placeholder="Strategy name (e.g. 'Dip-buy SOL on trend down')"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="input"
            />
            <textarea
              placeholder="Describe the rule: when to buy or sell, what to avoid, size/risk posture…"
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              className="input font-mono"
              rows={4}
            />
            <input
              placeholder="Notes (optional)"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              className="input"
            />
            <div className="flex items-center gap-3">
              <button onClick={addStrategy} disabled={stratBusy} className="btn btn-primary">
                {stratBusy ? <Spinner size={12} /> : 'Add strategy'}
              </button>
              {stratMsg && <span className="text-[12px]" style={{ color: 'var(--bad)' }}>{stratMsg}</span>}
            </div>
          </div>

          <div className="space-y-2 pt-2">
            {(strategies ?? []).length === 0 && (
              <div className="text-[12px] text-[color:var(--text-3)]">No strategies yet. Learned strategies will appear here as the agent discovers patterns.</div>
            )}
            {(strategies ?? []).map((s) => (
              <div key={s.id} className="panel" style={{ padding: '12px 14px' }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium truncate">{s.name}</span>
                      <span className="chip" style={{ fontSize: 10 }}>{s.source === 'LEARNED' ? 'learned' : 'yours'}</span>
                      {typeof s.score === 'number' && <span className="chip" style={{ fontSize: 10 }}>score {s.score.toFixed(1)}</span>}
                    </div>
                    {s.definition?.prompt && (
                      <div className="text-[12px] text-[color:var(--text-3)] mt-1 line-clamp-3 whitespace-pre-wrap">{s.definition.prompt}</div>
                    )}
                    {s.lastRationale && (
                      <div className="text-[11px] text-[color:var(--text-3)] mt-1 italic">{s.lastRationale}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <label className="flex items-center gap-1 cursor-pointer text-[12px]">
                      <input type="checkbox" checked={s.enabled} onChange={() => toggleStrategy(s)} className="accent-[color:var(--accent)]" />
                      {s.enabled ? 'On' : 'Off'}
                    </label>
                    <button onClick={() => deleteStrategy(s)} className="btn" style={{ color: 'var(--bad)', borderColor: 'var(--bad)', padding: '4px 10px', fontSize: 12 }}>
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* L4: Rules the agent has learned or been told */}
      <IntentRulesPanel />

      {/* L5: Per-user conviction weight sliders */}
      <ConvictionWeightsPanel />

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
              className="input w-full sm:max-w-sm"
            />
          </div>
          <div>
            <label className="label">Discord webhook URL</label>
            <input
              type="url"
              value={discordUrl}
              onChange={(e) => setDiscordUrl(e.target.value)}
              placeholder="https://discord.com/api/webhooks/... (optional)"
              className="input font-mono w-full sm:max-w-sm"
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

function ToggleSwitch({
  on,
  color = 'var(--ok)',
  onToggle,
}: {
  on: boolean;
  color?: string;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      style={{
        width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', flexShrink: 0,
        background: on ? color : 'var(--surface-2)',
        position: 'relative', transition: 'background 150ms',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, width: 16, height: 16, borderRadius: '50%',
        background: '#fff', transition: 'left 150ms',
        left: on ? 21 : 3,
      }} />
    </button>
  );
}

'use client';
import { useState } from 'react';
import { api } from '../lib/api';
import { useApi, invalidate } from '../lib/useApi';

type IntentScope = 'BLOCKLIST' | 'ALLOWLIST' | 'SIZING' | 'TIMING' | 'RISK' | 'PREFERENCE';
type IntentStatus = 'ACTIVE' | 'PROPOSED' | 'CONFLICTED' | 'RETIRED';

interface Rule {
  id: string;
  text: string;
  rule: Record<string, unknown>;
  scope: IntentScope;
  status: IntentStatus;
  priority: number;
  confidence: number;
  source: string;
  createdAt: string;
}

interface RulesResponse {
  active: Rule[];
  proposed: Rule[];
  conflicted: Rule[];
}

const SCOPES: { value: IntentScope; label: string; defaultRule: string }[] = [
  { value: 'BLOCKLIST', label: 'Blocklist', defaultRule: '{"kind":"block","token":"<address>"}' },
  { value: 'ALLOWLIST', label: 'Allowlist', defaultRule: '{"kind":"require","min_mcap_usd":10000000}' },
  { value: 'SIZING', label: 'Sizing', defaultRule: '{"kind":"max_size_usd","value":500,"per":"trade"}' },
  { value: 'TIMING', label: 'Timing', defaultRule: '{"kind":"time_window","allow_utc_hours":[8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]}' },
  { value: 'RISK', label: 'Risk', defaultRule: '{"kind":"require_approval_if","condition":{"notional_usd_gt":200}}' },
  { value: 'PREFERENCE', label: 'Preference', defaultRule: '{"kind":"prefer","chain":"SOLANA"}' },
];

export default function IntentRulesPanel() {
  const { data } = useApi<RulesResponse>('/me/rules');
  const [scope, setScope] = useState<IntentScope>('BLOCKLIST');
  const [text, setText] = useState('');
  const [ruleStr, setRuleStr] = useState(SCOPES[0].defaultRule);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function add() {
    setBusy(true); setMsg(null);
    try {
      const parsed = JSON.parse(ruleStr);
      await api.post('/me/rules', { text: text.trim(), rule: parsed, scope });
      setText(''); setRuleStr(SCOPES.find((s) => s.value === scope)!.defaultRule);
      invalidate('/me/rules');
    } catch (e: any) {
      setMsg(e?.message ?? 'Failed');
    } finally {
      setBusy(false);
    }
  }

  async function accept(id: string) { await api.post(`/me/rules/${id}/accept`, {}); invalidate('/me/rules'); }
  async function reject(id: string) { await api.post(`/me/rules/${id}/reject`, {}); invalidate('/me/rules'); }
  async function remove(id: string) { await api.delete(`/me/rules/${id}`); invalidate('/me/rules'); }

  const active = data?.active ?? [];
  const proposed = data?.proposed ?? [];

  return (
    <div className="panel">
      <h2 className="section-title mb-2">Rules I've taught you</h2>
      <p className="text-[13px] text-[color:var(--text-2)] mb-5">
        Durable rules the agent honors across chat and autonomous trades. Learned from chat + rejection feedback.
      </p>

      {proposed.length > 0 && (
        <div className="mb-4">
          <div className="text-[12px] font-medium mb-2" style={{ color: 'var(--warn)' }}>
            Awaiting confirmation ({proposed.length})
          </div>
          <div className="space-y-2">
            {proposed.map((r) => (
              <div key={r.id} className="panel" style={{ padding: '10px 12px' }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px]">{r.text}</div>
                    <div className="text-[10px] text-[color:var(--text-3)] mt-1">
                      {r.scope.toLowerCase()} · conf {(r.confidence * 100).toFixed(0)}% · from {r.source.toLowerCase()}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => accept(r.id)} className="btn btn-primary" style={{ padding: '4px 10px', fontSize: 12 }}>Accept</button>
                    <button onClick={() => reject(r.id)} className="btn" style={{ padding: '4px 10px', fontSize: 12 }}>Dismiss</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2 mb-5">
        <div className="text-[12px] font-medium">Active ({active.length})</div>
        {active.length === 0 ? (
          <div className="text-[12px] text-[color:var(--text-3)]">
            None yet. Tell the agent in chat — "never memecoins", "cap every trade at $500" — or add one below.
          </div>
        ) : (
          active.map((r) => (
            <div key={r.id} className="panel" style={{ padding: '10px 12px' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">{r.text}</div>
                  <div className="text-[10px] text-[color:var(--text-3)] mt-1">
                    <span className="chip mr-1" style={{ fontSize: 10 }}>{r.scope.toLowerCase()}</span>
                    priority {r.priority} · {r.source.toLowerCase()}
                  </div>
                </div>
                <button onClick={() => remove(r.id)} className="btn" style={{ padding: '4px 10px', fontSize: 12, color: 'var(--bad)', borderColor: 'var(--bad)' }}>
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="space-y-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="text-[12px] font-medium">Add rule manually</div>
        <input
          placeholder="Plain-English rule text (e.g. 'Never trade memecoins')"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="input"
          maxLength={400}
        />
        <select
          value={scope}
          onChange={(e) => {
            const next = e.target.value as IntentScope;
            setScope(next);
            setRuleStr(SCOPES.find((s) => s.value === next)!.defaultRule);
          }}
          className="input"
        >
          {SCOPES.map((s) => (<option key={s.value} value={s.value}>{s.label}</option>))}
        </select>
        <textarea
          value={ruleStr}
          onChange={(e) => setRuleStr(e.target.value)}
          className="input font-mono"
          rows={2}
          style={{ fontSize: 11 }}
        />
        <div className="flex items-center gap-3">
          <button onClick={add} disabled={busy || text.trim().length < 3} className="btn btn-primary">Add rule</button>
          {msg && <span className="text-[12px]" style={{ color: 'var(--bad)' }}>{msg}</span>}
        </div>
      </div>
    </div>
  );
}

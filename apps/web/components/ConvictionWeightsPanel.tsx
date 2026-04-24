'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useApi, invalidate } from '../lib/useApi';

interface WeightsRow {
  security: number;
  holders: number;
  liquidity: number;
  sentiment: number;
  momentum: number;
  version: number;
  sampleCount: number;
  manualOverride: boolean;
  learnedAt: string | null;
}

type Factor = 'security' | 'holders' | 'liquidity' | 'sentiment' | 'momentum';
const FACTORS: { key: Factor; label: string; hint: string }[] = [
  { key: 'security', label: 'Security', hint: 'Honeypot, audits, owner powers' },
  { key: 'holders', label: 'Holders', hint: 'Concentration, whale risk' },
  { key: 'liquidity', label: 'Liquidity', hint: 'Depth, pair quality' },
  { key: 'sentiment', label: 'Sentiment', hint: 'Social + news signal' },
  { key: 'momentum', label: 'Momentum', hint: 'Price + volume trend' },
];

const DEFAULTS: Record<Factor, number> = { security: 0.30, holders: 0.20, liquidity: 0.15, sentiment: 0.20, momentum: 0.15 };

export default function ConvictionWeightsPanel() {
  const { data } = useApi<WeightsRow>('/me/conviction-weights');
  const [weights, setWeights] = useState<Record<Factor, number> | null>(null);
  const [manualOverride, setManualOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (data && !weights) {
      setWeights({
        security: data.security, holders: data.holders, liquidity: data.liquidity,
        sentiment: data.sentiment, momentum: data.momentum,
      });
      setManualOverride(data.manualOverride);
    }
  }, [data, weights]);

  async function save() {
    if (!weights) return;
    setBusy(true); setMsg(null);
    try {
      await api.put('/me/conviction-weights', { ...weights, manualOverride });
      invalidate('/me/conviction-weights');
      setMsg('Saved');
    } catch (e: any) { setMsg(e?.message ?? 'Failed'); }
    finally { setBusy(false); }
  }

  async function reset() {
    if (!confirm('Reset to default weights?')) return;
    setBusy(true); setMsg(null);
    try {
      await api.post('/me/conviction-weights/reset', {});
      invalidate('/me/conviction-weights');
      setWeights({ ...DEFAULTS });
      setManualOverride(false);
    } catch (e: any) { setMsg(e?.message ?? 'Failed'); }
    finally { setBusy(false); }
  }

  if (!data || !weights) return null;
  const total = (weights.security + weights.holders + weights.liquidity + weights.sentiment + weights.momentum) || 1;

  return (
    <div className="panel">
      <h2 className="section-title mb-2">Conviction weights</h2>
      <p className="text-[13px] text-[color:var(--text-2)] mb-4">
        How much each signal influences the 1–10 conviction score. The agent learns these from your trade outcomes (every 6h)
        unless you lock them manually.
      </p>
      <div className="space-y-3">
        {FACTORS.map((f) => (
          <div key={f.key}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[13px] font-medium">{f.label}</span>
              <span className="text-[11px] text-[color:var(--text-3)]">
                {Math.round((weights[f.key] / total) * 100)}%
                <span className="ml-2">· {f.hint}</span>
              </span>
            </div>
            <input
              type="range"
              min={5}
              max={60}
              value={Math.round(weights[f.key] * 100)}
              onChange={(e) => setWeights({ ...weights, [f.key]: Number(e.target.value) / 100 })}
              className="w-full accent-[color:var(--accent)]"
            />
          </div>
        ))}
      </div>

      <label className="flex items-center gap-2 mt-4 cursor-pointer">
        <input
          type="checkbox"
          checked={!manualOverride}
          onChange={(e) => setManualOverride(!e.target.checked)}
          className="accent-[color:var(--accent)]"
        />
        <span className="text-[12px]">Let the agent keep learning these</span>
      </label>

      <div className="flex items-center gap-3 mt-4 text-[11px] text-[color:var(--text-3)]">
        <span>samples {data.sampleCount}</span>
        <span>version {data.version}</span>
        {data.learnedAt && <span>last learned {new Date(data.learnedAt).toLocaleString()}</span>}
      </div>

      <div className="flex items-center gap-2 mt-3">
        <button onClick={save} disabled={busy} className="btn btn-primary">Save</button>
        <button onClick={reset} disabled={busy} className="btn">Reset to defaults</button>
        {msg && <span className="text-[12px]">{msg}</span>}
      </div>
    </div>
  );
}

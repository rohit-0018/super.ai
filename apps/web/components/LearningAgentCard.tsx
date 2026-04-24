'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '../lib/api';
import { useApi, invalidate } from '../lib/useApi';
import { useRealtime } from '../lib/useRealtime';
import { Skeleton, Spinner } from './ui/Skeleton';
import RejectReasonPicker, { RejectCategory } from './RejectReasonPicker';

interface LearningConfig {
  enabled: boolean;
  autonomyLevel: 'MANUAL' | 'GUIDED' | 'SEMI_AUTO' | 'FULL_AUTO';
  maxTradeUsd: number;
  dailyLimit: number;
  dailyUsedCount: number;
}

interface PendingApproval {
  id: string;
  strategyId?: string | null;
  tradeIntent: {
    side?: 'buy' | 'sell';
    chain?: string;
    tokenOut?: string;
    notionalUsd?: number;
    reason?: string;
  };
  expiresAt: string;
  createdAt: string;
}

interface TradingDna {
  totalTrades: number;
  winRate: number;
  preferences?: {
    preferredChain?: string;
    topTokens?: string[];
    avgNotionalUsd?: number;
    activeHours?: number[];
  };
}

export default function LearningAgentCard() {
  const { data: lc } = useApi<LearningConfig>('/me/learning-config');
  const { data: pending } = useApi<PendingApproval[]>('/approvals/pending');
  const { data: dna } = useApi<TradingDna>('/me/dna');
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  useRealtime('approval_pending', () => invalidate('/approvals/pending'));
  useRealtime('approval_resolved', () => invalidate('/approvals/pending'));

  async function approve(id: string) {
    setBusy(id);
    try {
      await api.post(`/approvals/${id}/respond`, { accept: true });
      invalidate('/approvals/pending');
    } finally {
      setBusy(null);
    }
  }

  async function submitReject(id: string, payload: { rejectCategory: RejectCategory; rejectReason?: string }) {
    setBusy(id);
    try {
      await api.post(`/approvals/${id}/respond`, { accept: false, ...payload });
      setRejectingId(null);
      invalidate('/approvals/pending');
    } finally {
      setBusy(null);
    }
  }

  if (!lc) return <Skeleton w="100%" h={120} rounded="md" />;

  const off = !lc.enabled || lc.autonomyLevel === 'MANUAL';
  const tier = lc.autonomyLevel === 'FULL_AUTO' ? 'Full Auto'
    : lc.autonomyLevel === 'SEMI_AUTO' ? 'Semi-Auto'
    : lc.autonomyLevel === 'GUIDED' ? 'Guided'
    : 'Manual';
  const usedPct = lc.dailyLimit > 0 ? Math.min(100, (lc.dailyUsedCount / lc.dailyLimit) * 100) : 0;
  const prefs = dna?.preferences;

  return (
    <div className="panel">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="section-title mb-0">Learning agent</h3>
          <div className="text-[12px] text-[color:var(--text-3)] mt-0.5">
            {off ? 'Observing only (manual mode)' : `Autonomy: ${tier}`}
          </div>
        </div>
        <Link href="/settings" className="chip text-[11px]">Settings →</Link>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <div className="text-[11px] text-[color:var(--text-3)]">Daily trades</div>
          <div className="text-[14px] font-medium mt-1">{lc.dailyUsedCount} / {lc.dailyLimit}</div>
          <div className="h-1 rounded-full mt-1 overflow-hidden" style={{ background: 'var(--surface-2)' }}>
            <div className="h-full" style={{ width: `${usedPct}%`, background: 'var(--accent)' }} />
          </div>
        </div>
        <div>
          <div className="text-[11px] text-[color:var(--text-3)]">DNA samples</div>
          <div className="text-[14px] font-medium mt-1">{dna?.totalTrades ?? 0}</div>
          {dna && dna.totalTrades > 0 && (
            <div className="text-[11px] text-[color:var(--text-3)] mt-1">
              win {Math.round(dna.winRate * 100)}%
            </div>
          )}
        </div>
      </div>

      {prefs && (prefs.topTokens?.length || prefs.preferredChain) && (
        <div className="mb-4 text-[12px] text-[color:var(--text-2)]">
          {prefs.preferredChain && <span className="chip mr-1" style={{ fontSize: 10 }}>{prefs.preferredChain}</span>}
          {(prefs.topTokens ?? []).slice(0, 3).map((t) => (
            <span key={t} className="chip mr-1" style={{ fontSize: 10 }}>{t}</span>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <div className="text-[12px] font-medium">
          Pending approvals {pending?.length ? `(${pending.length})` : ''}
        </div>
        {!pending || pending.length === 0 ? (
          <div className="text-[12px] text-[color:var(--text-3)]">
            {off ? 'Enable Semi-Auto in Settings to see proposed trades here.' : 'No trades awaiting approval right now.'}
          </div>
        ) : (
          pending.slice(0, 3).map((a) => (
            <div key={a.id} className="panel" style={{ padding: '10px 12px' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium truncate">
                    {(a.tradeIntent.side ?? 'buy').toUpperCase()} {a.tradeIntent.tokenOut ?? '?'} · ${Math.round(a.tradeIntent.notionalUsd ?? 0)}
                  </div>
                  {a.tradeIntent.reason && (
                    <div className="text-[11px] text-[color:var(--text-3)] mt-0.5 line-clamp-2">{a.tradeIntent.reason}</div>
                  )}
                  <div className="text-[10px] text-[color:var(--text-3)] mt-0.5">
                    expires {new Date(a.expiresAt).toLocaleTimeString()}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => approve(a.id)}
                    disabled={busy === a.id}
                    className="btn btn-primary"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                  >
                    {busy === a.id ? <Spinner size={10} /> : 'Approve'}
                  </button>
                  <button
                    onClick={() => setRejectingId(rejectingId === a.id ? null : a.id)}
                    disabled={busy === a.id}
                    className="btn"
                    style={{ padding: '4px 10px', fontSize: 12, color: 'var(--bad)', borderColor: 'var(--bad)' }}
                  >
                    Reject
                  </button>
                </div>
              </div>
              {rejectingId === a.id && (
                <RejectReasonPicker
                  busy={busy === a.id}
                  onCancel={() => setRejectingId(null)}
                  onConfirm={(payload) => submitReject(a.id, payload)}
                />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

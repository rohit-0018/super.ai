'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRealtime } from '../lib/useRealtime';
import { useBannerSettings } from '../lib/useBannerSettings';
import { fmtPriceUsd } from '../lib/format-price';
import { api } from '../lib/api';

export interface SignalResult {
  address:        string;
  symbol:         string;
  name:           string;
  chain:          string;
  priceUsd:       number;
  marketCapUsd?:  number;
  score:          number;
  verdict:        'STRONG_BUY' | 'BUY' | 'CAUTIOUS' | 'SKIP' | 'HIGH_RISK';
  profileKey:     string;
  entryPriceUsd:  number;
  t1PriceUsd?:    number;
  t1Pct?:         number;
  t2PriceUsd?:    number;
  t2Pct?:         number;
  stopLossPriceUsd?: number;
  stopLossPct?:   number;
  holdRange?:     string;
  riskReward?:    number;
  bullishSignals: string[];
  riskFactors:    string[];
  aiSummary:      string;
  exitSizing?:    string;
  analyzedAt:     string;
  dexUrl?:        string;
}

interface BannerEntry { id: string; signal: SignalResult; exiting: boolean; autoBought?: boolean }

const VERDICT_COLOR: Record<string, string> = {
  STRONG_BUY: '#22c55e',
  BUY:        '#4ade80',
  CAUTIOUS:   '#f59e0b',
  SKIP:       '#8a8fa3',
  HIGH_RISK:  '#ef4444',
};

const VERDICT_LABEL: Record<string, string> = {
  STRONG_BUY: '🔥 STRONG BUY',
  BUY:        '✅ BUY',
  CAUTIOUS:   '⚠️ CAUTIOUS',
  SKIP:       '— SKIP',
  HIGH_RISK:  '🛑 HIGH RISK',
};

export default function SignalBanner() {
  const { settings } = useBannerSettings();
  const [banners, setBanners] = useState<BannerEntry[]>([]);
  const timerMap = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const router   = useRouter();

  const dismiss = useCallback((id: string) => {
    setBanners((prev) => prev.map((b) => b.id === id ? { ...b, exiting: true } : b));
    setTimeout(() => setBanners((prev) => prev.filter((b) => b.id !== id)), 350);
    const t = timerMap.current.get(id);
    if (t) { clearTimeout(t); timerMap.current.delete(id); }
  }, []);

  const show = useCallback(async (signal: SignalResult) => {
    if (!settings.enabled) return;
    if (signal.score < settings.minScore) return;

    let autoBought = false;

    // Auto-buy fast lane — call API immediately without waiting for user click
    if (settings.autoBuy) {
      try {
        await api.post('/hot-tokens/signal-buy', {
          address: signal.address,
          amountUsd: settings.positionSizeUsd,
        });
        autoBought = true;
      } catch {
        // Fall through — show banner as fallback so user can act manually
      }
    }

    const id = `${signal.address}-${Date.now()}`;
    setBanners((prev) => {
      // Deduplicate same address — replace if already showing
      const filtered = prev.filter((b) => b.signal.address !== signal.address);
      return [...filtered.slice(-2), { id, signal, exiting: false, autoBought }];
    });

    if (settings.sound) playBeep();

    // Auto-bought signals dismiss faster — user already acted
    const dismissAfter = autoBought ? Math.min(settings.dismissAfterSec || 15, 15) : settings.dismissAfterSec;
    if (dismissAfter > 0) {
      const t = setTimeout(() => dismiss(id), dismissAfter * 1_000);
      timerMap.current.set(id, t);
    }
  }, [settings, dismiss]);

  useRealtime('signal_alert', (data: SignalResult) => { void show(data); });

  useEffect(() => () => {
    for (const t of timerMap.current.values()) clearTimeout(t);
  }, []);

  if (!banners.length) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 'var(--topbar-h, 44px)',
      left: 56,   // rail width
      right: 0,
      zIndex: 50,
      pointerEvents: 'none',
    }}>
      {banners.map((b) => (
        <BannerCard
          key={b.id}
          entry={b}
          settings={settings}
          onDismiss={() => dismiss(b.id)}
          onBuy={() => {
            router.push(
              `/trade?address=${b.signal.address}&symbol=${b.signal.symbol}` +
              `&amount=${settings.positionSizeUsd}&signal=1`,
            );
            dismiss(b.id);
          }}
          onAnalyze={() => {
            router.push(`/intel?address=${b.signal.address}&profile=${b.signal.profileKey}`);
            dismiss(b.id);
          }}
        />
      ))}
    </div>
  );
}

interface CardProps {
  entry:      BannerEntry;
  settings:   ReturnType<typeof useBannerSettings>['settings'];
  onDismiss:  () => void;
  onBuy:      () => void;
  onAnalyze:  () => void;
}

function BannerCard({ entry, settings, onDismiss, onBuy, onAnalyze }: CardProps) {
  const { signal, exiting, autoBought } = entry;
  const color = VERDICT_COLOR[signal.verdict] ?? '#8a8fa3';
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <style>{`
        @keyframes sig-in  { from { transform: translateY(-8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes sig-out { from { transform: translateY(0); opacity: 1; } to { transform: translateY(-8px); opacity: 0; } }
      `}</style>
      <div
        className="sig-banner-track"
        style={{
          pointerEvents: 'auto',
          animation: exiting
            ? 'sig-out 320ms cubic-bezier(0.4,0,1,1) forwards'
            : 'sig-in 260ms cubic-bezier(0,0,0.2,1) forwards',
        }}
      >
        <div
          style={{
            background: `linear-gradient(90deg, color-mix(in srgb, ${color} 12%, var(--surface)) 0%, var(--surface) 60%)`,
            borderBottom: `1px solid color-mix(in srgb, ${color} 40%, var(--border))`,
            borderTop: `2px solid ${color}`,
            display: 'flex',
            alignItems: 'center',
            gap: 0,
            minHeight: 48,
            paddingLeft: 0,
            overflow: 'hidden',
          }}
        >
          {/* Left accent bar */}
          <div style={{ width: 3, alignSelf: 'stretch', background: color, flexShrink: 0 }} />

          {/* Verdict badge */}
          <div style={{
            padding: '0 14px',
            flexShrink: 0,
            borderRight: `1px solid color-mix(in srgb, ${color} 25%, var(--border))`,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            height: '100%',
            minWidth: 100,
            gap: 2,
          }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color, textTransform: 'uppercase' }}>
              {VERDICT_LABEL[signal.verdict]}
            </span>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 17, fontWeight: 700, color,
              textShadow: `0 0 12px color-mix(in srgb, ${color} 50%, transparent)`,
            }}>
              {signal.score}
              <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-3)' }}>/100</span>
            </span>
          </div>

          {/* Token info */}
          <div style={{ flex: 1, padding: '8px 14px', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>
                {signal.symbol}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-2)' }}>
                {fmtPriceUsd(signal.priceUsd)}
              </span>
              {signal.holdRange && (
                <span style={{ fontSize: 10, color: 'var(--text-3)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px' }}>
                  {signal.holdRange}
                </span>
              )}
              {signal.riskReward && (
                <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                  R:R {signal.riskReward.toFixed(1)}x
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 480 }}>
              {signal.aiSummary}
            </div>
          </div>

          {/* Exit targets */}
          <ExitTargets signal={signal} color={color} />

          {/* Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', flexShrink: 0 }}>
            <button
              onClick={() => setExpanded((v) => !v)}
              style={{
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '4px 8px', fontSize: 10, color: 'var(--text-2)',
                cursor: 'pointer', letterSpacing: '0.04em',
              }}
            >
              {expanded ? 'LESS' : 'MORE'}
            </button>
            <button
              onClick={onAnalyze}
              style={{
                background: 'var(--surface-2)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '4px 10px', fontSize: 11, color: 'var(--text)',
                cursor: 'pointer', fontWeight: 500,
              }}
            >
              Analyze
            </button>
            {autoBought ? (
              <div style={{
                background: `color-mix(in srgb, ${color} 15%, var(--surface-2))`,
                border: `1px solid ${color}`,
                borderRadius: 6, padding: '4px 14px', fontSize: 11, color,
                fontWeight: 700, letterSpacing: '0.04em',
              }}>
                ⚡ BOUGHT ${settings.positionSizeUsd}
              </div>
            ) : (
              <button
                onClick={onBuy}
                style={{
                  background: color, border: `1px solid ${color}`,
                  borderRadius: 6, padding: '4px 14px', fontSize: 12, color: '#fff',
                  cursor: 'pointer', fontWeight: 700, letterSpacing: '0.03em',
                  boxShadow: `0 0 12px color-mix(in srgb, ${color} 35%, transparent)`,
                }}
              >
                BUY ${settings.positionSizeUsd}
              </button>
            )}
            <button
              onClick={onDismiss}
              style={{
                background: 'transparent', border: 'none', color: 'var(--text-3)',
                cursor: 'pointer', padding: '4px 6px', fontSize: 14, lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Expanded detail row */}
        {expanded && (
          <div style={{
            background: `color-mix(in srgb, ${color} 4%, var(--bg-2))`,
            borderBottom: `1px solid color-mix(in srgb, ${color} 20%, var(--border))`,
            padding: '10px 17px',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '8px 24px',
          }}>
            {signal.bullishSignals.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--ok)', textTransform: 'uppercase', marginBottom: 4 }}>
                  Bullish
                </div>
                {signal.bullishSignals.slice(0, 4).map((s, i) => (
                  <div key={i} style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 2 }}>
                    <span style={{ color: 'var(--ok)', marginRight: 5 }}>+</span>{s}
                  </div>
                ))}
              </div>
            )}
            {signal.riskFactors.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--bad)', textTransform: 'uppercase', marginBottom: 4 }}>
                  Risks
                </div>
                {signal.riskFactors.slice(0, 4).map((r, i) => (
                  <div key={i} style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 2 }}>
                    <span style={{ color: 'var(--bad)', marginRight: 5 }}>—</span>{r}
                  </div>
                ))}
              </div>
            )}
            {signal.exitSizing && (
              <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--text-3)', borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 2 }}>
                <span style={{ color: 'var(--text-2)', fontWeight: 500 }}>Exit: </span>{signal.exitSizing}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function ExitTargets({ signal, color }: { signal: SignalResult; color: string }) {
  const has = signal.t1PriceUsd || signal.stopLossPriceUsd;
  if (!has) return null;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 3,
      padding: '6px 14px', borderRight: '1px solid var(--border)', flexShrink: 0,
      borderLeft: '1px solid var(--border)',
    }}>
      {signal.t1PriceUsd && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 12%, transparent)', borderRadius: 3, padding: '1px 4px' }}>T1</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ok)' }}>
            {fmtPriceUsd(signal.t1PriceUsd)}
            {signal.t1Pct != null && <span style={{ color: 'var(--text-3)', fontSize: 10 }}> +{signal.t1Pct.toFixed(0)}%</span>}
          </span>
        </div>
      )}
      {signal.t2PriceUsd && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)', borderRadius: 3, padding: '1px 4px' }}>T2</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent)' }}>
            {fmtPriceUsd(signal.t2PriceUsd)}
            {signal.t2Pct != null && <span style={{ color: 'var(--text-3)', fontSize: 10 }}> +{signal.t2Pct.toFixed(0)}%</span>}
          </span>
        </div>
      )}
      {signal.stopLossPriceUsd && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--bad)', background: 'color-mix(in srgb, var(--bad) 12%, transparent)', borderRadius: 3, padding: '1px 4px' }}>SL</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--bad)' }}>
            {fmtPriceUsd(signal.stopLossPriceUsd)}
            {signal.stopLossPct != null && <span style={{ color: 'var(--text-3)', fontSize: 10 }}> -{signal.stopLossPct.toFixed(0)}%</span>}
          </span>
        </div>
      )}
    </div>
  );
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  } catch { /* audio not available */ }
}

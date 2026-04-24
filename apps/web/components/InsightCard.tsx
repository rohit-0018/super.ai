'use client';
import { useState } from 'react';
import type {
  Insight, TradeInsight, DecisionInsight, ResearchInsight,
  WhaleInsight, TokenInsight, RiskInsight, LearningInsight,
  BriefingInsight, SocialInsight,
} from '../lib/insights-mock';
import { timeAgo } from '../lib/insights-mock';

/**
 * InsightCard — one card, many kinds. Collapsed by default; click to expand.
 * Left accent bar encodes kind. Header: icon · kind label · token · agent · time.
 */
export function InsightCard({ item }: { item: Insight }) {
  const [open, setOpen] = useState(false);
  const meta = KIND_META[item.kind];

  return (
    <article
      className="fade-in"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        boxShadow: 'var(--shadow-card)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Left accent bar */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 0, top: 0, bottom: 0,
          width: 3,
          background: meta.color,
        }}
      />

      {/* Header */}
      <header
        className="flex items-center gap-2 flex-wrap px-3 md:px-3.5 py-2"
        style={{ minHeight: 40, paddingLeft: 14, borderBottom: open ? '1px solid var(--border)' : undefined }}
      >
        <span
          aria-hidden
          className="inline-flex items-center justify-center shrink-0"
          style={{
            width: 22, height: 22, borderRadius: 6,
            background: `color-mix(in srgb, ${meta.color} 16%, var(--surface-2))`,
            color: meta.color,
            border: `1px solid color-mix(in srgb, ${meta.color} 30%, var(--border))`,
          }}
        >
          <meta.Icon />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wider shrink-0" style={{ color: meta.color }}>
          {meta.label}
        </span>
        {item.token && (
          <span className="chip">
            <span className="font-mono font-semibold">{item.token.symbol}</span>
            <span style={{ color: 'var(--text-3)' }}>·</span>
            <span style={{ color: 'var(--text-3)' }}>{item.token.chain}</span>
          </span>
        )}
        {item.agent && (
          <span className="chip chip-accent-2 hide-sm" title="Agent">
            <AgentDot />
            {item.agent}
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] shrink-0" style={{ color: 'var(--text-3)' }}>
          {timeAgo(item.ts)}
        </span>
        <button
          className="btn-icon shrink-0"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Collapse' : 'Expand'}
          title={open ? 'Collapse' : 'Expand'}
        >
          <Chevron open={open} />
        </button>
      </header>

      {/* Body */}
      <div className="px-3.5 py-3" style={{ paddingLeft: 14 }}>
        {renderBody(item, open)}
      </div>

      {open && (
        <footer className="px-3.5 py-2 flex gap-1.5" style={{ paddingLeft: 14, borderTop: '1px solid var(--border)', background: 'var(--bg-2)' }}>
          <button className="btn btn-sm btn-ghost">Pin</button>
          <button className="btn btn-sm btn-ghost">Share</button>
          <button className="btn btn-sm btn-ghost">Hide</button>
          <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }}>
            Open →
          </button>
        </footer>
      )}
    </article>
  );
}

/* ---------- Per-kind body renderers ---------- */

function renderBody(item: Insight, open: boolean): JSX.Element {
  switch (item.kind) {
    case 'trade':     return <TradeBody item={item} open={open} />;
    case 'decision':  return <DecisionBody item={item} open={open} />;
    case 'research':  return <ResearchBody item={item} open={open} />;
    case 'whale':     return <WhaleBody item={item} open={open} />;
    case 'token':     return <TokenBody item={item} open={open} />;
    case 'risk':      return <RiskBody item={item} open={open} />;
    case 'learning':  return <LearningBody item={item} open={open} />;
    case 'briefing':  return <BriefingBody item={item} open={open} />;
    case 'social':    return <SocialBody item={item} open={open} />;
  }
}

function TradeBody({ item, open }: { item: TradeInsight; open: boolean }) {
  const sideLabel = item.side === 'buy' ? 'Buy' : 'Sell';
  const sideColor = item.side === 'buy' ? 'var(--ok)' : 'var(--bad)';
  return (
    <>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-semibold" style={{ color: sideColor }}>{sideLabel}</span>
        <span className="font-mono text-[13px]">{item.qty}</span>
        <span className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>@</span>
        <span className="font-mono text-[13px]">{item.price}</span>
        <span className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>·</span>
        <span className="font-mono text-[12.5px]" style={{ color: 'var(--text-2)' }}>{item.notional}</span>
        <StatusPill status={item.status} />
        {item.pnl && (
          <span className={`stat-delta ${item.pnl.tone === 'up' ? 'up' : item.pnl.tone === 'down' ? 'down' : ''}`} style={{ marginLeft: 'auto' }}>
            {item.pnl.value}
          </span>
        )}
      </div>
      <p className="text-[12.5px] mt-1.5 leading-relaxed" style={{ color: open ? 'var(--text-2)' : 'var(--text-3)' }}>
        {item.reason}
      </p>
    </>
  );
}

function DecisionBody({ item, open }: { item: DecisionInsight; open: boolean }) {
  return (
    <>
      <p className="text-[13px] leading-relaxed">{item.summary}</p>
      {open && (
        <>
          <ul className="mt-2.5 space-y-1.5">
            {item.reasoning.map((r, i) => (
              <li key={i} className="text-[12.5px] flex gap-2" style={{ color: 'var(--text-2)' }}>
                <span style={{ color: 'var(--accent-2)' }}>◆</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
          {item.evidence && (
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
              {item.evidence.map((e) => (
                <div key={e.label} className="px-2.5 py-1.5 rounded-[8px]" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                  <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-3)' }}>{e.label}</div>
                  <div className="font-mono text-[12.5px] mt-0.5">{e.value}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

function ResearchBody({ item, open }: { item: ResearchInsight; open: boolean }) {
  return (
    <>
      <div className="text-[13px] font-semibold">{item.topic}</div>
      <p className="text-[12.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-2)' }}>{item.summary}</p>
      {open && (
        <ul className="mt-2.5 space-y-1.5">
          {item.findings.map((f, i) => (
            <li key={i} className="text-[12.5px] flex gap-2" style={{ color: 'var(--text-2)' }}>
              <span style={{ color: 'var(--accent)' }}>›</span>
              <span>{f}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function WhaleBody({ item, open }: { item: WhaleInsight; open: boolean }) {
  return (
    <>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-mono text-[12.5px]" style={{ color: 'var(--text-2)' }}>{item.wallet}</span>
        <span className="font-mono text-[12.5px]" style={{ color: 'var(--text-3)' }}>·</span>
        <span className="font-mono text-[13px]">{item.notional}</span>
      </div>
      <p className="text-[13px] mt-1 leading-relaxed">{item.action}</p>
      {open && item.cluster && (
        <div className="mt-2">
          <span className="chip chip-accent">{item.cluster}</span>
        </div>
      )}
    </>
  );
}

function TokenBody({ item, open }: { item: TokenInsight; open: boolean }) {
  const verdictColor =
    item.verdict === 'bullish' ? 'var(--ok)' :
    item.verdict === 'bearish' ? 'var(--bad)' :
    'var(--text-2)';
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <MiniStat label="Conviction" value={`${item.conviction}/10`} />
        <MiniStat label="Rug score" value={`${item.rugScore}/100`} tone={item.rugScore <= 20 ? 'ok' : item.rugScore <= 50 ? 'warn' : 'bad'} />
        <MiniStat label="Holders 24h" value={item.holdersDelta} tone={item.holdersDelta.startsWith('-') ? 'bad' : 'ok'} />
        <MiniStat label="Verdict" value={item.verdict} valueStyle={{ color: verdictColor, textTransform: 'capitalize' }} />
      </div>
      {open && (
        <p className="text-[12.5px] mt-2.5 leading-relaxed" style={{ color: 'var(--text-2)' }}>{item.notes}</p>
      )}
    </>
  );
}

function RiskBody({ item, open }: { item: RiskInsight; open: boolean }) {
  const sevColor = item.severity === 'high' ? 'var(--bad)' : item.severity === 'medium' ? 'var(--warn)' : 'var(--text-2)';
  return (
    <>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="chip" style={{ color: sevColor, borderColor: `color-mix(in srgb, ${sevColor} 35%, var(--border))`, background: `color-mix(in srgb, ${sevColor} 10%, var(--surface-2))` }}>
          {item.severity} · {item.blocked ? 'blocked' : 'warning'}
        </span>
        <span className="font-mono text-[11.5px]" style={{ color: 'var(--text-3)' }}>{item.rule}</span>
      </div>
      <p className="text-[12.5px] mt-1.5 leading-relaxed" style={{ color: open ? 'var(--text-2)' : 'var(--text-3)' }}>{item.note}</p>
    </>
  );
}

function LearningBody({ item, open }: { item: LearningInsight; open: boolean }) {
  return (
    <>
      <div className="text-[13px]">
        <span className="font-semibold">Trading DNA</span>
        <span style={{ color: 'var(--text-3)' }}> · {item.area}</span>
      </div>
      {open && (
        <div className="mt-2.5 space-y-1.5">
          {item.delta.map((d, i) => (
            <div key={i} className="flex items-center justify-between text-[12.5px]">
              <span style={{ color: 'var(--text-2)' }}>{d.label}</span>
              <span className={`stat-delta ${d.change.startsWith('-') ? 'down' : 'up'}`}>{d.change}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function BriefingBody({ item, open }: { item: BriefingInsight; open: boolean }) {
  return (
    <>
      <div className="flex items-baseline gap-2">
        <span className="text-[11.5px] uppercase tracking-wider" style={{ color: 'var(--text-3)' }}>{item.window} P&L</span>
        <span className={`stat-delta ${item.tone === 'up' ? 'up' : item.tone === 'down' ? 'down' : ''}`} style={{ fontSize: 13 }}>
          {item.pnl}
        </span>
      </div>
      {open ? (
        <ul className="mt-2.5 space-y-1.5">
          {item.highlights.map((h, i) => (
            <li key={i} className="text-[12.5px] flex gap-2" style={{ color: 'var(--text-2)' }}>
              <span style={{ color: 'var(--accent)' }}>·</span>
              <span>{h}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] mt-1" style={{ color: 'var(--text-3)' }}>
          {item.highlights.length} highlights — click to expand.
        </p>
      )}
    </>
  );
}

function SocialBody({ item, open }: { item: SocialInsight; open: boolean }) {
  return (
    <>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="chip">{item.source}</span>
        <span className="text-[13px] font-semibold">{item.topic}</span>
      </div>
      <p className="text-[12.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-2)' }}>{item.signal}</p>
      {open && (
        <div className="mt-1 font-mono text-[11.5px]" style={{ color: 'var(--text-3)' }}>{item.mentions}</div>
      )}
    </>
  );
}

/* ---------- Small pieces ---------- */

function MiniStat({ label, value, tone, valueStyle }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad'; valueStyle?: React.CSSProperties }) {
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'bad' ? 'var(--bad)' : 'var(--text)';
  return (
    <div className="px-2.5 py-1.5 rounded-[8px]" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-3)' }}>{label}</div>
      <div className="font-mono text-[12.5px] mt-0.5" style={{ color, ...valueStyle }}>{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: 'filled' | 'partial' | 'rejected' }) {
  const cls = status === 'filled' ? 'chip chip-ok' : status === 'rejected' ? 'chip chip-bad' : 'chip chip-warn';
  return <span className={cls} style={{ marginLeft: 4, textTransform: 'capitalize' }}>{status}</span>;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: `rotate(${open ? 180 : 0}deg)`, transition: 'transform 160ms ease' }}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function AgentDot() {
  return (
    <span aria-hidden style={{ width: 5, height: 5, borderRadius: 999, background: 'currentColor', boxShadow: '0 0 4px currentColor' }} />
  );
}

/* ---------- Kind metadata (colors + icons) ---------- */

const KIND_META: Record<Insight['kind'], { label: string; color: string; Icon: () => JSX.Element }> = {
  trade:    { label: 'Trade',     color: 'var(--accent)',  Icon: IconTrade },
  decision: { label: 'Decision',  color: 'var(--accent-2)', Icon: IconBrain },
  research: { label: 'Research',  color: 'var(--accent-2)', Icon: IconDoc },
  whale:    { label: 'Whale',     color: 'var(--accent)',  Icon: IconWhale },
  token:    { label: 'Token intel', color: 'var(--accent)', Icon: IconGem },
  risk:     { label: 'Risk',      color: 'var(--bad)',     Icon: IconShield },
  learning: { label: 'Learning',  color: 'var(--accent-2)', Icon: IconSpark },
  briefing: { label: 'Briefing',  color: 'var(--accent)',  Icon: IconSun },
  social:   { label: 'Social',    color: 'var(--text-2)',  Icon: IconMega },
};

function I({ children }: { children: React.ReactNode }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}
function IconTrade()  { return <I><path d="M3 17l6-6 4 4 8-8"/><path d="M21 7h-5"/><path d="M21 7v5"/></I>; }
function IconBrain()  { return <I><path d="M9 3a3 3 0 0 0-3 3v1a3 3 0 0 0-3 3v2a3 3 0 0 0 3 3v1a3 3 0 0 0 3 3h1V3z"/><path d="M15 3a3 3 0 0 1 3 3v1a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3v1a3 3 0 0 1-3 3h-1V3z"/></I>; }
function IconDoc()    { return <I><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8 13h8"/><path d="M8 17h5"/></I>; }
function IconWhale()  { return <I><path d="M3 12c3 0 5-3 9-3s7 3 9 3-3 5-9 5-6-3-9-3"/><circle cx="15" cy="11" r="0.6" fill="currentColor"/></I>; }
function IconGem()    { return <I><path d="M6 3h12l3 6-9 12L3 9z"/><path d="M3 9h18"/><path d="M12 3l-4 6 4 12 4-12-4-6"/></I>; }
function IconShield() { return <I><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></I>; }
function IconSpark()  { return <I><path d="M12 3v4"/><path d="M12 17v4"/><path d="M3 12h4"/><path d="M17 12h4"/><path d="M5.6 5.6l2.8 2.8"/><path d="M15.6 15.6l2.8 2.8"/><path d="M5.6 18.4l2.8-2.8"/><path d="M15.6 8.4l2.8-2.8"/></I>; }
function IconSun()    { return <I><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.9 4.9l1.4 1.4"/><path d="M17.7 17.7l1.4 1.4"/><path d="M4.9 19.1l1.4-1.4"/><path d="M17.7 6.3l1.4-1.4"/></I>; }
function IconMega()   { return <I><path d="M3 11v2a2 2 0 0 0 2 2h2l8 5V4L7 9H5a2 2 0 0 0-2 2z"/></I>; }

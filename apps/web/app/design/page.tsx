'use client';
/**
 * qwai UI kit — redline this page before rolling changes into real routes.
 * Every primitive in the design system is shown here with realistic data.
 * Load via: http://localhost:3001/design
 */
import { useState } from 'react';
import { Section } from '../../components/ui/Section';
import { Stat, DeltaPill } from '../../components/ui/Stat';

export default function DesignKit() {
  return (
    <div className="page page-wide space-y-4 md:space-y-6">
      <HeaderBlock />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4 min-w-0">
          <HeroStats />
          <PositionsTable />
          <OrderForm />
          <ChatBlock />
        </div>
        <div className="space-y-4 min-w-0">
          <ButtonShowcase />
          <ChipShowcase />
          <InputShowcase />
          <StatShowcase />
          <StateShowcase />
        </div>
      </div>
    </div>
  );
}

/* ---------- Header ---------- */
function HeaderBlock() {
  return (
    <header className="flex items-baseline justify-between gap-4 flex-wrap">
      <div>
        <div className="section-eyebrow">qwai · internal</div>
        <h1 className="font-display text-[26px] font-semibold tracking-tight mt-1">Design kit</h1>
        <p className="text-[12.5px] mt-0.5" style={{ color: 'var(--text-2)' }}>
          MetaMask-inspired pro trading terminal. Every primitive in one page. Redline before rollout.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span className="chip">
          <span className="live-dot" />
          live tokens
        </span>
        <span className="chip chip-accent">v0.1</span>
      </div>
    </header>
  );
}

/* ---------- Hero stats ---------- */
function HeroStats() {
  return (
    <Section
      title="Portfolio"
      subtitle="24h"
      actions={
        <>
          <button className="btn btn-sm btn-ghost">7D</button>
          <button className="btn btn-sm">30D</button>
          <button className="btn btn-sm btn-ghost">All</button>
        </>
      }
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
        <Stat
          size="hero"
          label="Net value"
          value="$48,291.44"
          delta="+2.31%"
          deltaTone="up"
          hint="+$1,088.12 today"
        />
        <Stat label="Realised P&L" value="$2,841.12" delta="+4.1%" deltaTone="up" size="md" />
        <Stat label="Unrealised" value="$1,203.42" delta="-0.8%" deltaTone="down" size="md" />
        <Stat label="Win rate" value="68%" delta="+3pp" deltaTone="up" size="md" hint="38 of 56 trades" />
      </div>
    </Section>
  );
}

/* ---------- Positions table ---------- */
function PositionsTable() {
  const rows = [
    { sym: 'SOL',  chain: 'Solana', qty: '218.44', entry: '$118.40', mark: '$142.33', value: '$31,087.02', pnl: '+$5,224', tone: 'up'   as const },
    { sym: 'ETH',  chain: 'EVM',    qty: '3.182',  entry: '$3,088',  mark: '$3,214',  value: '$10,225.24', pnl: '+$401',   tone: 'up'   as const },
    { sym: 'JUP',  chain: 'Solana', qty: '4,202',  entry: '$0.91',   mark: '$0.82',   value: '$3,446.00',  pnl: '-$378',   tone: 'down' as const },
    { sym: 'WIF',  chain: 'Solana', qty: '1,820',  entry: '$2.12',   mark: '$1.94',   value: '$3,530.80',  pnl: '-$327',   tone: 'down' as const },
    { sym: 'BONK', chain: 'Solana', qty: '9.2M',   entry: '$0.0000219','mark': '$0.0000234', value: '$215.28', pnl: '+$14', tone: 'up' as const },
  ];
  return (
    <Section
      title="Positions"
      subtitle={`${rows.length} open`}
      flush
      actions={
        <>
          <button className="btn btn-sm btn-ghost">Export</button>
          <button className="btn btn-sm">See all</button>
        </>
      }
    >
      <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Chain</th>
            <th className="num">Qty</th>
            <th className="num">Entry</th>
            <th className="num">Mark</th>
            <th className="num">Value</th>
            <th className="num">P&L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sym}>
              <td>
                <span className="font-semibold">{r.sym}</span>
              </td>
              <td>
                <span className="chip">{r.chain}</span>
              </td>
              <td className="num">{r.qty}</td>
              <td className="num" style={{ color: 'var(--text-2)' }}>{r.entry}</td>
              <td className="num">{r.mark}</td>
              <td className="num">{r.value}</td>
              <td className="num">
                <DeltaPill tone={r.tone}>{r.pnl}</DeltaPill>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </Section>
  );
}

/* ---------- Order form ---------- */
function OrderForm() {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<'market' | 'limit'>('market');
  return (
    <Section
      title="New order"
      actions={
        <span className="chip chip-warn">
          <span className="live-dot" style={{ background: 'var(--warn)' }} />
          paper mode
        </span>
      }
    >
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 flex gap-0">
          <button
            onClick={() => setSide('buy')}
            className="btn"
            style={{
              flex: 1,
              borderRadius: '8px 0 0 8px',
              background: side === 'buy' ? 'color-mix(in srgb, var(--ok) 18%, var(--surface))' : 'var(--surface)',
              borderColor: side === 'buy' ? 'color-mix(in srgb, var(--ok) 60%, var(--border-2))' : 'var(--border-2)',
              color: side === 'buy' ? 'var(--ok)' : 'var(--text-2)',
            }}
          >
            Buy
          </button>
          <button
            onClick={() => setSide('sell')}
            className="btn"
            style={{
              flex: 1,
              borderRadius: '0 8px 8px 0',
              marginLeft: -1,
              background: side === 'sell' ? 'color-mix(in srgb, var(--bad) 18%, var(--surface))' : 'var(--surface)',
              borderColor: side === 'sell' ? 'color-mix(in srgb, var(--bad) 60%, var(--border-2))' : 'var(--border-2)',
              color: side === 'sell' ? 'var(--bad)' : 'var(--text-2)',
            }}
          >
            Sell
          </button>
        </div>
        <div className="col-span-6">
          <label className="label">Token</label>
          <select className="input">
            <option>SOL</option>
            <option>ETH</option>
            <option>JUP</option>
          </select>
        </div>
        <div className="col-span-6">
          <label className="label">Type</label>
          <select className="input" value={type} onChange={(e) => setType(e.target.value as any)}>
            <option value="market">Market</option>
            <option value="limit">Limit</option>
          </select>
        </div>
        <div className="col-span-6">
          <label className="label">Amount</label>
          <input className="input mono" placeholder="0.00" defaultValue="50.00" />
        </div>
        <div className="col-span-6">
          <label className="label">{type === 'limit' ? 'Limit price' : 'Estimated price'}</label>
          <input className="input mono" placeholder="0.00" defaultValue="142.33" disabled={type === 'market'} />
        </div>
        <div className="col-span-12 flex items-center justify-between mt-1 p-2.5 rounded-[8px]"
             style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
          <span className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>Estimated fill</span>
          <span className="mono text-[12.5px]">50.00 SOL · ~$7,116.50 · slip 0.02%</span>
        </div>
        <div className="col-span-12 flex gap-2">
          <button className="btn btn-primary btn-lg" style={{ flex: 1 }}>Place order</button>
          <button className="btn btn-lg">Simulate</button>
        </div>
      </div>
    </Section>
  );
}

/* ---------- Chat block ---------- */
function ChatBlock() {
  return (
    <Section title="Agent chat" subtitle="Claude Opus · paper mode">
      <div className="flex flex-col gap-2">
        <div className="flex">
          <div className="bubble bubble-assistant">
            Hey — overnight SOL is up <strong>4.2%</strong>. Your DCA agent filled <code>50 SOL</code> at
            {' '}<code>$138.20</code>. Want me to set a trailing stop at 8%?
          </div>
        </div>
        <div className="flex">
          <div className="bubble bubble-user">Yes, 8% trailing. Also sell half if we hit $160.</div>
        </div>
        <div className="flex">
          <div className="bubble bubble-assistant">
            Confirmed. Trailing stop armed at <code>$130.94</code>, sell-half trigger at <code>$160.00</code>.
            <div className="typing-dots mt-2"><span/><span/><span/></div>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap mt-1">
          <button className="suggest-chip">Run guardrails check</button>
          <button className="suggest-chip">Show my agents</button>
          <button className="suggest-chip">What's the risk on WIF?</button>
        </div>
        <div className="flex gap-2 mt-2">
          <input className="input" placeholder="Message your agent…" />
          <button className="btn btn-primary">Send</button>
        </div>
      </div>
    </Section>
  );
}

/* ---------- Buttons ---------- */
function ButtonShowcase() {
  return (
    <Section title="Buttons">
      <div className="flex flex-wrap gap-2 mb-3">
        <button className="btn btn-primary">Primary</button>
        <button className="btn">Secondary</button>
        <button className="btn btn-ghost">Ghost</button>
        <button className="btn btn-accent-2">AI action</button>
        <button className="btn btn-destructive">Destructive</button>
        <button className="btn" disabled>Disabled</button>
      </div>
      <div className="flex flex-wrap gap-2 mb-3">
        <button className="btn btn-sm btn-primary">sm primary</button>
        <button className="btn btn-sm">sm secondary</button>
        <button className="btn btn-sm btn-ghost">sm ghost</button>
        <button className="btn btn-lg btn-primary">lg primary</button>
      </div>
      <div className="flex gap-1">
        <button className="btn-icon" aria-label="Refresh">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>
        </button>
        <button className="btn-icon" aria-label="Share">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.5 15.4 6.5"/><path d="M8.6 13.5 15.4 17.5"/></svg>
        </button>
        <button className="btn-icon" aria-label="More">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/></svg>
        </button>
      </div>
    </Section>
  );
}

/* ---------- Chips ---------- */
function ChipShowcase() {
  return (
    <Section title="Chips & pills">
      <div className="flex flex-wrap gap-2 mb-3">
        <span className="chip">default</span>
        <span className="chip chip-accent">data</span>
        <span className="chip chip-accent-2">AI</span>
        <span className="chip chip-ok">success</span>
        <span className="chip chip-warn">paper</span>
        <span className="chip chip-bad">risk</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <span className="chip"><span className="live-dot" /> live</span>
        <span className="chip chip-ok"><span className="live-dot" /> online</span>
        <DeltaPill tone="up">+4.2%</DeltaPill>
        <DeltaPill tone="down">-1.8%</DeltaPill>
        <DeltaPill tone="flat">0.0%</DeltaPill>
        <span className="kbd">⌘K</span>
        <span className="kbd">Esc</span>
        <span className="kbd">Enter</span>
      </div>
    </Section>
  );
}

/* ---------- Inputs ---------- */
function InputShowcase() {
  return (
    <Section title="Inputs">
      <div className="grid grid-cols-1 gap-3">
        <div>
          <label className="label">Text</label>
          <input className="input" placeholder="ticker, address, or command" />
        </div>
        <div>
          <label className="label">Amount (mono)</label>
          <input className="input mono" placeholder="0.00" defaultValue="1,250.00" />
        </div>
        <div>
          <label className="label">Select</label>
          <select className="input">
            <option>Jupiter (Solana)</option>
            <option>1inch (EVM)</option>
            <option>Binance</option>
          </select>
        </div>
        <div>
          <label className="label">Textarea</label>
          <textarea className="textarea" placeholder="Describe a strategy…" defaultValue="Buy SOL on every 5% dip, max 10% of portfolio. Stop 12%." />
        </div>
      </div>
    </Section>
  );
}

/* ---------- Stats ---------- */
function StatShowcase() {
  return (
    <Section title="Numbers & deltas">
      <div className="grid grid-cols-2 gap-4">
        <Stat size="sm" label="Balance" value="$48.2K" delta="+2.3%" deltaTone="up" />
        <Stat size="sm" label="24h Vol" value="$1.24M" delta="-0.4%" deltaTone="down" />
        <Stat label="SOL" value="$142.33" delta="+4.2%" deltaTone="up" />
        <Stat label="BTC" value="$68,120" delta="-0.8%" deltaTone="down" />
      </div>
    </Section>
  );
}

/* ---------- States ---------- */
function StateShowcase() {
  return (
    <Section title="Loading & empty">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="qwai-spinner" style={{ width: 18, height: 18 }} />
          <span className="text-[12.5px]" style={{ color: 'var(--text-2)' }}>Signing transaction…</span>
        </div>
        <div className="space-y-2">
          <div className="skeleton" style={{ height: 12, width: '70%' }} />
          <div className="skeleton" style={{ height: 12, width: '50%' }} />
          <div className="skeleton" style={{ height: 12, width: '85%' }} />
        </div>
        <div
          className="rounded-[10px] p-4 text-center"
          style={{ background: 'var(--surface-2)', border: '1px dashed var(--border-2)' }}
        >
          <div className="text-[12.5px] font-semibold">No alerts</div>
          <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--text-3)' }}>
            We'll surface risk flags and filled orders here.
          </div>
        </div>
      </div>
    </Section>
  );
}

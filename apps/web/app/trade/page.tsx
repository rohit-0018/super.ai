'use client';
import TradingViewChart from '../../components/TradingViewChart';
import SwapForm from '../../components/SwapForm';
import RiskMeter from '../../components/RiskMeter';
import TokenIntelCard from '../../components/TokenIntelCard';
import { Section } from '../../components/ui/Section';
import { Stat, DeltaPill } from '../../components/ui/Stat';

export default function TradePage() {
  return (
    <div className="page page-wide space-y-4">
      <header className="page-header">
        <div>
          <div className="section-eyebrow">Workstation</div>
          <h1 className="page-title">Trade</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="chip"><span className="live-dot" /> SOL · $142.33</span>
          <span className="chip chip-warn">paper</span>
        </div>
      </header>

      {/* Chart fills left, right column: swap + risk + intel */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 min-w-0">
          <Section title="SOL / USDT" subtitle="Binance" flush>
            <TradingViewChart symbol="BINANCE:SOLUSDT" />
          </Section>
        </div>
        <div className="space-y-4 min-w-0">
          <SwapForm />
          <RiskMeter />
          <TokenIntelCard />
        </div>
      </div>

      {/* Positions summary */}
      <Section
        title="Positions"
        subtitle="5 open"
        flush
        actions={<a href="/analytics" className="btn btn-sm btn-ghost">Open journal →</a>}
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
            {ROWS.map((r) => (
              <tr key={r.sym}>
                <td className="font-semibold">{r.sym}</td>
                <td><span className="chip">{r.chain}</span></td>
                <td className="num">{r.qty}</td>
                <td className="num" style={{ color: 'var(--text-2)' }}>{r.entry}</td>
                <td className="num">{r.mark}</td>
                <td className="num">{r.value}</td>
                <td className="num"><DeltaPill tone={r.tone}>{r.pnl}</DeltaPill></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Section>
    </div>
  );
}

const ROWS = [
  { sym: 'SOL', chain: 'Solana', qty: '218.44', entry: '$118.40', mark: '$142.33', value: '$31,087.02', pnl: '+$5,224', tone: 'up' as const },
  { sym: 'ETH', chain: 'EVM',    qty: '3.182',  entry: '$3,088',  mark: '$3,214',  value: '$10,225.24', pnl: '+$401',   tone: 'up' as const },
  { sym: 'JUP', chain: 'Solana', qty: '4,202',  entry: '$0.91',   mark: '$0.82',   value: '$3,446.00',  pnl: '-$378',   tone: 'down' as const },
  { sym: 'WIF', chain: 'Solana', qty: '1,820',  entry: '$2.12',   mark: '$1.94',   value: '$3,530.80',  pnl: '-$327',   tone: 'down' as const },
  { sym: 'BONK', chain: 'Solana', qty: '9.2M',  entry: '$0.0000219', mark: '$0.0000234', value: '$215.28', pnl: '+$14',  tone: 'up' as const },
];

'use client';
import TradingViewChart from '../../components/TradingViewChart';
import PortfolioCard from '../../components/PortfolioCard';
import ChatPanel from '../../components/ChatPanel';
import TradeJournal from '../../components/TradeJournal';
import TokenIntelCard from '../../components/TokenIntelCard';
import SwapForm from '../../components/SwapForm';

export default function Dashboard() {
  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Dashboard</h1>
          <p className="text-[13px] text-[color:var(--text-2)] mt-1">
            Markets, portfolio, and your AI trading agent.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="chip">
            <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--ok)]" />
            Live
          </span>
        </div>
      </header>

      <section className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-8 panel !p-0 overflow-hidden">
          <TradingViewChart symbol="BINANCE:SOLUSDT" />
        </div>
        <div className="col-span-12 lg:col-span-4 grid gap-4">
          <PortfolioCard />
          <TokenIntelCard />
        </div>
      </section>

      <section className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-4">
          <SwapForm />
        </div>
        <div className="col-span-12 lg:col-span-8">
          <ChatPanel />
        </div>
      </section>

      <section>
        <div className="panel">
          <h3 className="section-title mb-4">Trade journal</h3>
          <TradeJournal />
        </div>
      </section>
    </div>
  );
}

'use client';
import TradingViewChart from '../../components/TradingViewChart';
import PortfolioCard from '../../components/PortfolioCard';
import ChatPanel from '../../components/ChatPanel';
import TradeJournal from '../../components/TradeJournal';
import TokenIntelCard from '../../components/TokenIntelCard';
import SwapForm from '../../components/SwapForm';
import AgentsPanel from '../../components/AgentsPanel';
import RiskMeter from '../../components/RiskMeter';
import BriefingCard from '../../components/BriefingCard';
import AlertsFeed from '../../components/AlertsFeed';
import TrendingMovers from '../../components/TrendingMovers';

export default function Dashboard() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Dashboard</h1>
          <p className="text-[13px] text-[color:var(--text-2)] mt-1">
            Your markets, portfolio, agents, and AI copilot.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="chip">
            <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--ok)]" />
            Live data
          </span>
        </div>
      </header>

      {/* Row 1: briefing banner */}
      <section>
        <BriefingCard />
      </section>

      {/* Row 2: chart · portfolio · token intel */}
      <section className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-8 panel !p-0 overflow-hidden">
          <TradingViewChart symbol="BINANCE:SOLUSDT" />
        </div>
        <div className="col-span-12 lg:col-span-4 grid gap-4">
          <PortfolioCard />
          <TokenIntelCard />
        </div>
      </section>

      {/* Row 3: agents · risk meter */}
      <section className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-7">
          <AgentsPanel />
        </div>
        <div className="col-span-12 lg:col-span-5">
          <RiskMeter />
        </div>
      </section>

      {/* Row 4: trending + alerts */}
      <section className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-6">
          <TrendingMovers />
        </div>
        <div className="col-span-12 lg:col-span-6">
          <AlertsFeed />
        </div>
      </section>

      {/* Row 5: swap · chat */}
      <section className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-4">
          <SwapForm />
        </div>
        <div className="col-span-12 lg:col-span-8">
          <ChatPanel />
        </div>
      </section>

      {/* Row 6: trade journal */}
      <section>
        <div className="panel">
          <div className="flex items-center justify-between mb-4">
            <h3 className="section-title mb-0">Trade journal</h3>
            <a
              href="/analytics"
              className="text-[12px] text-[color:var(--text-3)] hover:text-[color:var(--accent)]"
            >
              View analytics →
            </a>
          </div>
          <TradeJournal />
        </div>
      </section>
    </div>
  );
}

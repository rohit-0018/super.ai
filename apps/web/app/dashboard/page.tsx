'use client';
import TradingViewChart from '../../components/TradingViewChart';
import PortfolioCard from '../../components/PortfolioCard';
import TokenIntelCard from '../../components/TokenIntelCard';
import SwapForm from '../../components/SwapForm';
import RiskMeter from '../../components/RiskMeter';
import BriefingCard from '../../components/BriefingCard';

export default function Dashboard() {
  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Dashboard</h1>
          <p className="text-[13px] text-[color:var(--text-2)] mt-0.5">
            Your markets, portfolio, and AI copilot.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="chip">
            <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--ok)]" />
            Live data
          </span>
        </div>
      </header>

      <BriefingCard />

      {/* Chart + portfolio */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 xl:col-span-8 panel !p-0 overflow-hidden">
          <TradingViewChart symbol="BINANCE:SOLUSDT" />
        </div>
        <div className="col-span-12 xl:col-span-4 grid gap-4">
          <PortfolioCard />
          <TokenIntelCard />
        </div>
      </div>

      {/* Swap + Risk */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 md:col-span-6">
          <SwapForm />
        </div>
        <div className="col-span-12 md:col-span-6">
          <RiskMeter />
        </div>
      </div>
    </div>
  );
}

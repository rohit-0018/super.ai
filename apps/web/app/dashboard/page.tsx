'use client';
import { useState } from 'react';
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

type Tab = 'overview' | 'agents' | 'market' | 'journal';

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <div className="space-y-4">
      {/* Header + tab nav */}
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Dashboard</h1>
          <p className="text-[13px] text-[color:var(--text-2)] mt-0.5">
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

      {/* Main grid: left content + right chat (always visible) */}
      <div className="grid grid-cols-12 gap-4" style={{ minHeight: 'calc(100vh - 180px)' }}>
        {/* Left column — scrollable content */}
        <div className="col-span-12 lg:col-span-7 xl:col-span-8 space-y-4">
          {/* Briefing banner (compact) */}
          <BriefingCard />

          {/* Tab bar */}
          <div className="flex gap-0.5 p-0.5 rounded-lg w-fit" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className="px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors"
                style={
                  tab === t.key
                    ? { background: 'var(--surface)', color: 'var(--text)', boxShadow: '0 1px 2px rgba(0,0,0,0.15)' }
                    : { color: 'var(--text-2)' }
                }
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          {tab === 'overview' && (
            <div className="space-y-4 fade-in">
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
          )}

          {tab === 'agents' && (
            <div className="space-y-4 fade-in">
              <AgentsPanel />
              <AlertsFeed />
            </div>
          )}

          {tab === 'market' && (
            <div className="space-y-4 fade-in">
              <TrendingMovers />
              <TokenIntelCard />
            </div>
          )}

          {tab === 'journal' && (
            <div className="space-y-4 fade-in">
              <div className="panel">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="section-title mb-0">Trade journal</h3>
                  <a href="/analytics" className="text-[12px] text-[color:var(--text-3)] hover:text-[color:var(--accent)]">
                    View analytics →
                  </a>
                </div>
                <TradeJournal />
              </div>
            </div>
          )}
        </div>

        {/* Right column — chat (sticky, always visible without scrolling) */}
        <div className="col-span-12 lg:col-span-5 xl:col-span-4">
          <div className="lg:sticky lg:top-[72px]">
            <ChatPanel />
          </div>
        </div>
      </div>
    </div>
  );
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'agents', label: 'Agents & Alerts' },
  { key: 'market', label: 'Market' },
  { key: 'journal', label: 'Journal' },
];

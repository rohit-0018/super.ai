'use client';
import TradingViewChart from '../../components/TradingViewChart';
import PortfolioCard from '../../components/PortfolioCard';
import ChatPanel from '../../components/ChatPanel';
import TradeJournal from '../../components/TradeJournal';

export default function Dashboard() {
  return (
    <div className="grid grid-cols-12 gap-4">
      <div className="col-span-8 panel">
        <TradingViewChart symbol="BINANCE:SOLUSDT" />
      </div>
      <div className="col-span-4 grid gap-4">
        <PortfolioCard />
        <ChatPanel />
      </div>
      <div className="col-span-12 panel">
        <TradeJournal />
      </div>
    </div>
  );
}

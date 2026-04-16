import TrendingMovers from '../../components/TrendingMovers';
import TokenIntelCard from '../../components/TokenIntelCard';

export default function MarketPage() {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Market</h1>
        <p className="text-[13px] text-[color:var(--text-2)] mt-0.5">
          Trending tokens, movers, and intelligence.
        </p>
      </header>
      <TrendingMovers />
      <TokenIntelCard />
    </div>
  );
}

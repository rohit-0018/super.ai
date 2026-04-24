'use client';
import TokenIntelCard from '../../components/TokenIntelCard';
import TrendingMovers from '../../components/TrendingMovers';
import { Section } from '../../components/ui/Section';

export default function TokensPage() {
  return (
    <div className="page space-y-4">
      <header>
        <div className="section-eyebrow">Tokens</div>
        <h1 className="page-title">Token intel</h1>
        <p className="page-subtitle">
          Conviction scores, rug checks, holder analytics — across Solana and EVM.
        </p>
      </header>

      <TrendingMovers />
      <TokenIntelCard />

      <Section title="Watchlist" subtitle="12 tokens">
        <div
          className="rounded-[10px] p-6 text-center"
          style={{ background: 'var(--surface-2)', border: '1px dashed var(--border-2)' }}
        >
          <div className="text-[13px] font-semibold">Watchlist coming soon</div>
          <div className="text-[12px] mt-1" style={{ color: 'var(--text-3)' }}>
            Pin tokens from intel cards or insight feed to track conviction + rug score over time.
          </div>
        </div>
      </Section>
    </div>
  );
}

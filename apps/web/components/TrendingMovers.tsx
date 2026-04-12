'use client';
import { useState } from 'react';
import { useApi } from '../lib/useApi';
import { Skeleton } from './ui/Skeleton';

interface Trending {
  item: {
    id: string;
    coin_id?: number;
    name: string;
    symbol: string;
    small?: string;
    thumb?: string;
    market_cap_rank?: number;
    data?: {
      price?: number | string;
      price_change_percentage_24h?: { usd?: number };
      market_cap?: string;
    };
  };
}

interface Mover {
  id: string;
  symbol: string;
  name: string;
  image?: string;
  current_price?: number;
  price_change_percentage_24h?: number;
}

type Tab = 'trending' | 'movers';

export default function TrendingMovers() {
  const [tab, setTab] = useState<Tab>('trending');
  const trendingQ = useApi<{ coins: Trending[] } | Trending[]>('/market/trending');
  const moversQ = useApi<Mover[]>('/market/top-movers');

  const trending: Trending[] | null = trendingQ.data
    ? Array.isArray(trendingQ.data)
      ? trendingQ.data
      : ((trendingQ.data as any).coins ?? [])
    : null;
  const movers = moversQ.data ?? null;

  const loading = (trendingQ.loading && !trending) || (moversQ.loading && !movers);
  const error = trendingQ.error || moversQ.error;
  const list = tab === 'trending' ? trending : movers;

  return (
    <div className="panel h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="section-title mb-0.5">Market pulse</h3>
          <div className="text-[11px] text-[color:var(--text-3)]">
            Trending + top 24h gainers
          </div>
        </div>
        <div className="flex gap-0.5 p-0.5 rounded-md" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
          <TabBtn active={tab === 'trending'} onClick={() => setTab('trending')}>Trending</TabBtn>
          <TabBtn active={tab === 'movers'} onClick={() => setTab('movers')}>Movers</TabBtn>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto -mx-2 pr-2">
        {loading ? (
          <ul className="space-y-2 px-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 py-2">
                <Skeleton w={28} h={28} rounded="full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton w="40%" h={12} />
                  <Skeleton w="20%" h={10} />
                </div>
                <Skeleton w={60} h={12} />
              </li>
            ))}
          </ul>
        ) : error ? (
          <p className="text-[13px] text-[color:var(--bad)] px-2">{error}</p>
        ) : !list || list.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-[color:var(--text-3)]">
            No data
          </div>
        ) : tab === 'trending' ? (
          <ul className="fade-in">
            {(list as Trending[]).slice(0, 8).map((t, i) => (
              <li
                key={t.item.id}
                className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-[color:var(--surface-hover)] transition-colors"
              >
                <span
                  className="w-5 text-[11px] text-[color:var(--text-3)] font-mono shrink-0"
                >
                  {i + 1}
                </span>
                {t.item.thumb || t.item.small ? (
                  <img
                    src={t.item.small || t.item.thumb}
                    alt={t.item.symbol}
                    width={24}
                    height={24}
                    className="rounded-full shrink-0"
                  />
                ) : (
                  <div className="w-6 h-6 rounded-full shrink-0" style={{ background: 'var(--surface-2)' }} />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] font-medium truncate">{t.item.name}</div>
                  <div className="text-[10.5px] text-[color:var(--text-3)] font-mono uppercase">
                    {t.item.symbol}
                  </div>
                </div>
                {t.item.data?.price_change_percentage_24h?.usd != null && (
                  <PctPill pct={t.item.data.price_change_percentage_24h.usd} />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <ul className="fade-in">
            {(list as Mover[]).slice(0, 8).map((m, i) => (
              <li
                key={m.id}
                className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-[color:var(--surface-hover)] transition-colors"
              >
                <span className="w-5 text-[11px] text-[color:var(--text-3)] font-mono shrink-0">{i + 1}</span>
                {m.image ? (
                  <img src={m.image} alt={m.symbol} width={24} height={24} className="rounded-full shrink-0" />
                ) : (
                  <div className="w-6 h-6 rounded-full shrink-0" style={{ background: 'var(--surface-2)' }} />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] font-medium truncate">{m.name}</div>
                  <div className="text-[10.5px] text-[color:var(--text-3)] font-mono uppercase">{m.symbol}</div>
                </div>
                <div className="text-right">
                  {m.current_price != null && (
                    <div className="text-[11.5px] font-mono">${formatPrice(m.current_price)}</div>
                  )}
                  {m.price_change_percentage_24h != null && (
                    <PctPill pct={m.price_change_percentage_24h} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-2.5 py-1 rounded text-[11px] font-medium transition-colors"
      style={
        active
          ? { background: 'var(--surface)', color: 'var(--text)' }
          : { color: 'var(--text-2)' }
      }
    >
      {children}
    </button>
  );
}

function PctPill({ pct }: { pct: number }) {
  const up = pct >= 0;
  return (
    <span
      className="text-[11px] font-mono"
      style={{ color: up ? 'var(--ok)' : 'var(--bad)' }}
    >
      {up ? '+' : ''}{pct.toFixed(2)}%
    </span>
  );
}

function formatPrice(n: number): string {
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 0.01) return n.toFixed(4);
  return n.toPrecision(3);
}

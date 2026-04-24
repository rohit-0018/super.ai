export type TickerItem = {
  symbol: string;
  price: string;
  delta: string;
  tone: 'up' | 'down' | 'flat';
};

export function TickerBar({ items }: { items: TickerItem[] }) {
  const doubled = [...items, ...items];
  return (
    <div className="ticker-row flex-1 min-w-0">
      <div className="ticker-track">
        {doubled.map((it, i) => (
          <span key={i} className="ticker-item">
            <span className="sym">{it.symbol}</span>
            <span className="val">{it.price}</span>
            <span
              className="mono"
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                color:
                  it.tone === 'up'
                    ? 'var(--ok)'
                    : it.tone === 'down'
                    ? 'var(--bad)'
                    : 'var(--text-3)',
              }}
            >
              {it.tone === 'up' ? '▲' : it.tone === 'down' ? '▼' : '·'} {it.delta}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

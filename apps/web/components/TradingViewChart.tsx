'use client';
import { useEffect, useRef } from 'react';

export default function TradingViewChart({ symbol }: { symbol: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const id = `tv_${Math.random().toString(36).slice(2)}`;
    ref.current.id = id;
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.onload = () => {
      // @ts-ignore
      new window.TradingView.widget({
        autosize: true, symbol, interval: '60', theme: 'dark', container_id: id,
      });
    };
    document.body.appendChild(script);
    return () => { script.remove(); };
  }, [symbol]);
  return <div ref={ref} style={{ height: 480 }} />;
}

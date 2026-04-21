'use client';
import { useEffect, useRef } from 'react';

export default function TradingViewChart({ symbol }: { symbol: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    let cancelled = false;
    const id = `tv_${Math.random().toString(36).slice(2)}`;
    host.id = id;

    const mount = () => {
      if (cancelled) return;
      if (!document.getElementById(id)) return;
      const TV = (window as any).TradingView;
      if (!TV?.widget) return;
      try {
        new TV.widget({
          autosize: true, symbol, interval: '60', theme: 'dark', container_id: id,
        });
      } catch (err) {
        console.warn('[TradingView] init failed:', err);
      }
    };

    if ((window as any).TradingView?.widget) {
      mount();
      return () => { cancelled = true; };
    }

    let script = document.querySelector<HTMLScriptElement>('script[data-tv-loader="1"]');
    const created = !script;
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://s3.tradingview.com/tv.js';
      script.async = true;
      script.dataset.tvLoader = '1';
      document.body.appendChild(script);
    }
    script.addEventListener('load', mount, { once: true });
    if ((script as any).readyState === 'complete') mount();

    return () => {
      cancelled = true;
      script?.removeEventListener('load', mount);
      if (created) script?.remove();
    };
  }, [symbol]);
  return <div ref={ref} style={{ height: 480 }} />;
}

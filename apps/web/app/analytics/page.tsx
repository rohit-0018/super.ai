'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

export default function Analytics() {
  const [perf, setPerf] = useState<any>(null);
  useEffect(() => {
    api.get('/analytics/performance').then((r) => setPerf(r.data)).catch(() => setPerf({}));
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Analytics</h1>
        <p className="text-[13px] text-[color:var(--text-2)] mt-1">
          Performance, PnL, and trade diagnostics.
        </p>
      </header>

      <div className="panel">
        <h2 className="section-title mb-4">Performance</h2>
        {perf ? (
          <pre className="text-[12px] font-mono text-[color:var(--text-2)] overflow-x-auto">
            {JSON.stringify(perf, null, 2)}
          </pre>
        ) : (
          <p className="text-[13px] text-[color:var(--text-3)]">Loading…</p>
        )}
      </div>
    </div>
  );
}

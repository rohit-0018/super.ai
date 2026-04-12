'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Skeleton, SkeletonText } from '../../components/ui/Skeleton';

export default function Analytics() {
  const [perf, setPerf] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/analytics/performance')
      .then((r) => { if (!cancelled) setPerf(r.data); })
      .catch((e: any) => {
        if (!cancelled) {
          setError(e?.message ?? 'Failed to load');
          setPerf({});
        }
      });
    return () => { cancelled = true; };
  }, []);

  const loading = perf === null;

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
        {loading ? (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="px-3 py-3 rounded-lg"
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
                >
                  <Skeleton w="60%" h={10} className="mb-2" />
                  <Skeleton w="40%" h={20} />
                </div>
              ))}
            </div>
            <SkeletonText lines={4} />
          </div>
        ) : error ? (
          <p className="text-[13px] text-[color:var(--bad)]">{error}</p>
        ) : (
          <pre className="text-[12px] font-mono text-[color:var(--text-2)] overflow-x-auto fade-in">
            {JSON.stringify(perf, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

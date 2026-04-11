'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

export default function Analytics() {
  const [perf, setPerf] = useState<any>(null);
  useEffect(() => { api.get('/analytics/performance').then((r) => setPerf(r.data)).catch(() => setPerf({})); }, []);
  return (
    <div className="grid gap-4">
      <div className="panel">
        <h2 className="font-bold text-xl mb-2">Performance</h2>
        {perf ? <pre className="text-xs opacity-80">{JSON.stringify(perf, null, 2)}</pre> : 'Loading…'}
      </div>
    </div>
  );
}

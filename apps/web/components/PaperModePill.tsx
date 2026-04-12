'use client';
import { useState } from 'react';
import { api } from '../lib/api';
import { useApi, mutate } from '../lib/useApi';
import { Skeleton, Spinner } from './ui/Skeleton';

interface Me { paperMode: boolean }

export default function PaperModePill() {
  const { data: me, loading } = useApi<Me>('/me');
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (!me || busy) return;
    setBusy(true);
    const next = !me.paperMode;
    // Optimistic: broadcast to every subscriber of /me
    mutate<Me>('/me', (prev) => ({ ...(prev ?? { paperMode: false }), paperMode: next }));
    try {
      await api.post('/me/paper-mode', { paperMode: next });
    } catch {
      mutate<Me>('/me', (prev) => ({ ...(prev ?? { paperMode: false }), paperMode: !next }));
    } finally {
      setBusy(false);
    }
  }

  if (loading || !me) return <Skeleton w={86} h={24} rounded="md" />;

  const live = !me.paperMode;
  return (
    <button
      onClick={toggle}
      disabled={busy}
      className="chip cursor-pointer hover:border-[color:var(--accent)] transition-colors"
      style={{
        color: live ? 'var(--ok)' : 'var(--warn)',
        borderColor: live ? 'color-mix(in srgb, var(--ok) 40%, var(--border))' : 'color-mix(in srgb, var(--warn) 40%, var(--border))',
        gap: 6,
      }}
      title={live ? 'Live trading — click to switch to paper' : 'Paper trading — click to go live'}
    >
      {busy ? (
        <Spinner size={10} />
      ) : (
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: live ? 'var(--ok)' : 'var(--warn)' }}
        />
      )}
      {live ? 'Live' : 'Paper'}
    </button>
  );
}

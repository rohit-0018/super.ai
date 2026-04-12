'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth-store';
import { Skeleton, Spinner } from './ui/Skeleton';

interface Me { paperMode: boolean }

export default function PaperModePill() {
  const { accessToken, hydrated } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!hydrated || !accessToken) { setMe(null); return; }
    let cancelled = false;
    api
      .get<Me>('/me')
      .then((r) => { if (!cancelled) setMe(r.data); })
      .catch(() => { if (!cancelled) setMe({ paperMode: true }); });
    return () => { cancelled = true; };
  }, [hydrated, accessToken]);

  if (!hydrated || !accessToken) return null;

  async function toggle() {
    if (!me || busy) return;
    setBusy(true);
    const next = !me.paperMode;
    // optimistic
    setMe({ paperMode: next });
    try {
      await api.post('/me/paper-mode', { paperMode: next });
    } catch {
      setMe({ paperMode: !next });
    } finally {
      setBusy(false);
    }
  }

  if (!me) return <Skeleton w={86} h={24} rounded="md" />;

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

'use client';
import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '../lib/auth-store';
import { useRealtime } from '../lib/useRealtime';

const PUBLIC_ROUTES = ['/', '/login'];

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const { accessToken, hydrated, hydrate } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated) return;
    if (!accessToken && !PUBLIC_ROUTES.includes(pathname)) {
      router.replace('/login');
    }
  }, [hydrated, accessToken, pathname, router]);

  // Connect to WebSocket for real-time updates (no-op on public pages / when not authed)
  useRealtime('_noop', () => {});

  const blocked = !hydrated || (!accessToken && !PUBLIC_ROUTES.includes(pathname));
  if (blocked) {
    return <div className="p-8 text-[13px] text-[color:var(--text-3)]">Loading…</div>;
  }
  return <>{children}</>;
}

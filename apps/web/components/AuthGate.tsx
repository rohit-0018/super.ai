'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '../lib/auth-store';
import { useRealtime } from '../lib/useRealtime';

const PUBLIC_ROUTES = ['/', '/login', '/login/', '/design', '/design/'];

function isPublic(pathname: string) {
  return PUBLIC_ROUTES.includes(pathname) || pathname.startsWith('/login') || pathname.startsWith('/design');
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const { accessToken, hydrated, hydrate } = useAuth();
  const pathname = usePathname();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated) return;
    if (!accessToken && !isPublic(pathname)) {
      window.location.replace('/login/');
    }
  }, [hydrated, accessToken, pathname]);

  // Connect to WebSocket for real-time updates (no-op on public pages / when not authed)
  useRealtime('_noop', () => {});

  const blocked = !hydrated || (!accessToken && !isPublic(pathname));
  if (blocked) {
    return <div className="p-8 text-[13px] text-[color:var(--text-3)]">Loading…</div>;
  }
  return <>{children}</>;
}

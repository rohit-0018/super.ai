'use client';
import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '../lib/auth-store';

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

  if (!hydrated) {
    return <div className="p-8 text-[13px] text-[color:var(--text-3)]">Loading…</div>;
  }
  return <>{children}</>;
}

'use client';
import { create } from 'zustand';
import { api, setToken } from './api';

interface Stored {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  hydrated: boolean;
  hydrate: () => void;
  setTokens: (a: string, r: string, expiresIn?: number) => void;
  logout: () => void;
}

const KEY = 'qwai.auth';

function persist(state: Stored | null) {
  if (typeof window === 'undefined') return;
  if (state) window.localStorage.setItem(KEY, JSON.stringify(state));
  else window.localStorage.removeItem(KEY);
}

function read(): Stored | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.accessToken || !parsed?.refreshToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export const useAuth = create<AuthState>((set, get) => {
  // Install the refresh hook on module init so the api client can trigger it.
  api.setRefreshHook({
    getRefreshToken: () => get().refreshToken,
    onRefreshed: (accessToken, refreshToken, expiresIn) => {
      const expiresAt = expiresIn > 0 ? Date.now() + expiresIn * 1000 : null;
      setToken(accessToken);
      persist({ accessToken, refreshToken, expiresAt: expiresAt ?? undefined });
      set({ accessToken, refreshToken, expiresAt });
    },
    onSessionLost: () => {
      setToken(null);
      persist(null);
      set({ accessToken: null, refreshToken: null, expiresAt: null });
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    },
  });

  return {
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    hydrated: false,
    hydrate: () => {
      const stored = read();
      if (stored) {
        setToken(stored.accessToken);
        set({
          accessToken: stored.accessToken,
          refreshToken: stored.refreshToken,
          expiresAt: stored.expiresAt ?? null,
          hydrated: true,
        });
        return;
      }
      set({ hydrated: true });
    },
    setTokens: (accessToken, refreshToken, expiresIn) => {
      const expiresAt = expiresIn && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null;
      setToken(accessToken);
      persist({ accessToken, refreshToken, expiresAt: expiresAt ?? undefined });
      set({ accessToken, refreshToken, expiresAt });
    },
    logout: () => {
      const rt = get().refreshToken;
      if (rt) {
        // Fire-and-forget — don't block the UI on backend revocation.
        api.post('/auth/logout', { refreshToken: rt }).catch(() => {});
      }
      setToken(null);
      persist(null);
      set({ accessToken: null, refreshToken: null, expiresAt: null });
    },
  };
});

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

/** Guards against installing the cross-tab listener more than once. */
let storageSyncInstalled = false;

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
      /**
       * A failed refresh does NOT always mean the session is dead.
       *
       * Refresh tokens rotate server-side, so two tabs (or a tab plus a
       * background reload) that refresh at the same moment produce one winner
       * and one loser. The loser's token is genuinely invalid — but the winner
       * already wrote a fresh, working token to localStorage. Wiping here would
       * destroy a live session and bounce BOTH tabs to /login, which is exactly
       * the spurious logout this guard prevents.
       *
       * So: re-read storage first. If the stored refresh token is different
       * from the one we hold, another context rotated it — adopt it and carry
       * on. Only wipe when storage confirms we are still the current holder.
       */
      const stored = read();
      const current = get().refreshToken;
      if (stored && stored.refreshToken && stored.refreshToken !== current) {
        setToken(stored.accessToken);
        set({
          accessToken: stored.accessToken,
          refreshToken: stored.refreshToken,
          expiresAt: stored.expiresAt ?? null,
        });
        return;
      }

      setToken(null);
      persist(null);
      set({ accessToken: null, refreshToken: null, expiresAt: null });
      if (typeof window !== 'undefined') {
        const p = window.location.pathname;
        const isPublic = p === '/' || p.startsWith('/login');
        if (!isPublic) window.location.href = '/login';
      }
    },
  });

  return {
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    hydrated: false,
    hydrate: () => {
      /**
       * Adopt token rotations performed by other tabs.
       *
       * `storage` fires only in OTHER tabs, which is exactly what we want: when
       * one tab refreshes and rotates, every other tab picks up the new pair
       * instead of continuing with a token the server has already invalidated.
       * Without this, the second tab's next request 401s and races again.
       */
      if (typeof window !== 'undefined' && !storageSyncInstalled) {
        storageSyncInstalled = true;
        window.addEventListener('storage', (e) => {
          if (e.key !== KEY) return;
          if (!e.newValue) {
            // Another tab logged out — follow it rather than making calls that
            // will all 401.
            setToken(null);
            set({ accessToken: null, refreshToken: null, expiresAt: null });
            return;
          }
          try {
            const next = JSON.parse(e.newValue) as Stored;
            if (!next?.accessToken || !next?.refreshToken) return;
            setToken(next.accessToken);
            set({
              accessToken: next.accessToken,
              refreshToken: next.refreshToken,
              expiresAt: next.expiresAt ?? null,
            });
          } catch {
            /* malformed payload — ignore rather than dropping the session */
          }
        });
      }

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

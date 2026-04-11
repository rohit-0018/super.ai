'use client';
import { create } from 'zustand';
import { setToken } from './api';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  hydrated: boolean;
  hydrate: () => void;
  setTokens: (a: string, r: string) => void;
  logout: () => void;
}

const KEY = 'qwai.auth';

export const useAuth = create<AuthState>((set) => ({
  accessToken: null,
  refreshToken: null,
  hydrated: false,
  hydrate: () => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) {
        const { accessToken, refreshToken } = JSON.parse(raw);
        setToken(accessToken);
        set({ accessToken, refreshToken, hydrated: true });
        return;
      }
    } catch {}
    set({ hydrated: true });
  },
  setTokens: (accessToken, refreshToken) => {
    setToken(accessToken);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(KEY, JSON.stringify({ accessToken, refreshToken }));
    }
    set({ accessToken, refreshToken });
  },
  logout: () => {
    setToken(null);
    if (typeof window !== 'undefined') window.localStorage.removeItem(KEY);
    set({ accessToken: null, refreshToken: null });
  },
}));

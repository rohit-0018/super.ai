'use client';
import { create } from 'zustand';
import { setToken } from './api';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  setTokens: (a: string, r: string) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  accessToken: null,
  refreshToken: null,
  setTokens: (accessToken, refreshToken) => {
    setToken(accessToken);
    set({ accessToken, refreshToken });
  },
  logout: () => { setToken(null); set({ accessToken: null, refreshToken: null }); },
}));

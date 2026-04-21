'use client';
import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from './auth-store';
import { invalidate } from './useApi';

type EventHandler = (data: any) => void;

let socket: any = null;
let listeners = new Map<string, Set<EventHandler>>();
let connectPromise: Promise<void> | null = null;

async function getSocket(apiBase: string): Promise<any> {
  if (socket?.connected) return socket;
  if (connectPromise) { await connectPromise; return socket; }

  connectPromise = (async () => {
    const { io } = await import('socket.io-client');
    const wsUrl = apiBase.replace(/\/api$/, '').replace(/^http/, 'ws');
    socket = io(wsUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 20,
    });

    socket.on('connect', () => {
      const userId = (window as any).__qwai_userId;
      if (userId) socket.emit('subscribe', `user:${userId}`);
    });

    socket.on('alert', (data: any) => {
      invalidate('/alerts?limit=15');
      emit('alert', data);
    });

    socket.on('agent_update', (data: any) => {
      invalidate('/agents');
      emit('agent_update', data);
    });

    socket.on('trade_confirmed', (data: any) => {
      invalidate('/orders');
      invalidate('/wallets');
      invalidate('/guardrails');
      invalidate('/analytics/performance');
      emit('trade_confirmed', data);
    });

    socket.on('price', (data: any) => {
      emit('price', data);
    });

    socket.on('order_triggered', (data: any) => {
      invalidate('/orders');
      invalidate('/agents');
      invalidate('/alerts?limit=15');
      emit('order_triggered', data);
    });

    await new Promise<void>((resolve) => {
      if (socket.connected) { resolve(); return; }
      socket.once('connect', resolve);
      setTimeout(resolve, 3001);
    });
  })();
  await connectPromise;
  connectPromise = null;
  return socket;
}

function emit(event: string, data: any) {
  const handlers = listeners.get(event);
  if (handlers) handlers.forEach((fn) => fn(data));
}

function addListener(event: string, fn: EventHandler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(fn);
}

function removeListener(event: string, fn: EventHandler) {
  const set = listeners.get(event);
  if (set) { set.delete(fn); if (set.size === 0) listeners.delete(event); }
}

export function disconnectRealtime() {
  if (socket) { socket.disconnect(); socket = null; }
  listeners.clear();
}

export function useRealtime(event: string, handler: EventHandler) {
  const { accessToken, hydrated } = useAuth();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const stableHandler = useCallback((data: any) => handlerRef.current(data), []);

  useEffect(() => {
    if (!hydrated || !accessToken) return;

    const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4400/api';

    try {
      const jwt = JSON.parse(atob(accessToken.split('.')[1]));
      (window as any).__qwai_userId = jwt.sub;
    } catch {}

    addListener(event, stableHandler);
    getSocket(apiBase).catch(() => {});

    return () => { removeListener(event, stableHandler); };
  }, [hydrated, accessToken, event, stableHandler]);
}

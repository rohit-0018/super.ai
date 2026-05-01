'use client';
import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from './auth-store';
import { invalidate } from './useApi';

type EventHandler = (data: any) => void;

let socket: any = null;
let listeners = new Map<string, Set<EventHandler>>();
let connectPromise: Promise<void> | null = null;

function resubscribe() {
  const userId = (window as any).__qwai_userId;
  if (userId && socket?.connected) {
    socket.emit('subscribe', `user:${userId}`);
  }
}

async function getSocket(apiBase: string): Promise<any> {
  if (socket?.connected) return socket;
  if (connectPromise) { await connectPromise; return socket; }

  connectPromise = (async () => {
    const { io } = await import('socket.io-client');
    // socket.io-client expects http:// or https://, not ws:// — keep the protocol as-is
    const wsUrl = apiBase.replace(/\/api$/, '');
    socket = io(wsUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 20,
    });

    socket.on('connect', () => {
      resubscribe();
    });

    socket.on('disconnect', () => {
      // On disconnect, clear the promise so next getSocket() re-creates if needed
    });

    // Catch-all handler: routes every server event through the listener system.
    // This handles both built-in events (alert, trade_confirmed, …) and
    // snipe-specific events (snipe_triggered, snipe_sold, tg_status, tg_message)
    // without requiring a hardcoded list to be maintained here.
    socket.onAny((event: string, data: any) => {
      switch (event) {
        case 'alert':
          invalidate('/alerts?limit=20');
          invalidate('/alerts?limit=15');
          invalidate('/alerts/unread-count');
          break;
        case 'agent_update':
          invalidate('/agents');
          break;
        case 'trade_confirmed':
          invalidate('/orders');
          invalidate('/wallets');
          invalidate('/guardrails');
          invalidate('/analytics/performance');
          break;
        case 'order_triggered':
          invalidate('/orders');
          invalidate('/agents');
          invalidate('/alerts?limit=15');
          break;
        case 'approval_pending':
        case 'approval_resolved':
          invalidate('/approvals/pending');
          break;
        case 'snipe_triggered':
        case 'snipe_sold':
          invalidate('/snipe/history?limit=50');
          break;
        case 'tg_status':
          invalidate('/snipe/tg/status');
          break;
        case 'hot_tokens_update':
          // useHotTokens handles this directly via its own useRealtime call;
          // also invalidate the REST cache for any direct pollers.
          invalidate('/hot-tokens');
          break;
      }
      emit(event, data);
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
      // If socket already connected (race: socket connected before userId decoded),
      // subscribe immediately so we don't wait for the next reconnect event.
      if (socket?.connected) {
        socket.emit('subscribe', `user:${jwt.sub}`);
      }
    } catch {}

    addListener(event, stableHandler);
    getSocket(apiBase).catch(() => {});

    return () => { removeListener(event, stableHandler); };
  }, [hydrated, accessToken, event, stableHandler]);
}

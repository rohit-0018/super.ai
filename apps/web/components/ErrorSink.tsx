'use client';
import { useEffect } from 'react';

/**
 * Silently swallow unhandled promise rejections and window errors so they
 * don't surface in the UI (Next.js dev overlay, wallet extension toasts,
 * etc). Everything still lands in the devtools console.
 */
export default function ErrorSink() {
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      console.error('[unhandled rejection]', e.reason);
    };
    const onError = (e: ErrorEvent) => {
      console.error('[window error]', e.error ?? e.message);
    };
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);
  return null;
}

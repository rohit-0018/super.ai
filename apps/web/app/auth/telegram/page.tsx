'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '../../../lib/auth-store';
import { api } from '../../../lib/api';

function TelegramLinkInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { accessToken } = useAuth();
  const token = searchParams.get('token');

  const [status, setStatus] = useState<'checking' | 'linking' | 'success' | 'error'>('checking');
  const [errMsg, setErrMsg] = useState('');
  const [botUsername, setBotUsername] = useState<string | null>(null);

  // Resolve the actual bot username so the "Back to Bot" link points to the
  // right bot regardless of which token is configured on the API.
  useEffect(() => {
    api.get<{ username: string | null }>('/telegram/me')
      .then((res) => setBotUsername(res?.data?.username ?? null))
      .catch(() => setBotUsername(null));
  }, []);

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setErrMsg('No link token found. Generate a new one by sending /login to the QWAI bot.');
      return;
    }

    if (!accessToken) {
      // Store token so we can reclaim after login
      sessionStorage.setItem('tg_link_token', token);
      router.replace(`/login?redirect=${encodeURIComponent(`/auth/telegram?token=${token}`)}`);
      return;
    }

    setStatus('linking');
    api.post<{ chatId: string }>('/auth/telegram/claim', { token })
      .then(() => setStatus('success'))
      .catch((e: any) => {
        setStatus('error');
        setErrMsg(
          e?.response?.data?.message ??
          e?.message ??
          'Link failed. The token may have expired — send /login again in the bot.',
        );
      });
  }, [token, accessToken, router]);

  const botHref = botUsername ? `https://t.me/${botUsername}` : 'https://t.me/';

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    }}>
      <div className="section" style={{ maxWidth: 420, width: '100%', padding: 32, textAlign: 'center' }}>

        {/* Telegram icon */}
        <div style={{
          width: 64, height: 64, borderRadius: '50%',
          background: 'linear-gradient(135deg, #0088cc 0%, #00c6ff 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 24px',
        }}>
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
            <path d="M22 2L11 13" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>

        {status === 'checking' && (
          <>
            <h2 className="text-h2" style={{ marginBottom: 8 }}>Checking…</h2>
            <p className="text-body" style={{ color: 'var(--text-2)' }}>Verifying your session</p>
          </>
        )}

        {status === 'linking' && (
          <>
            <h2 className="text-h2" style={{ marginBottom: 8 }}>Linking account…</h2>
            <p className="text-body" style={{ color: 'var(--text-2)' }}>Connecting your Telegram to QWAI</p>
            <div style={{ marginTop: 20, position: 'relative', height: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ position: 'absolute', top: 0, height: '100%', background: 'var(--accent)', borderRadius: 2, animation: 'load-bar 1.6s ease-in-out infinite' }} />
            </div>
          </>
        )}

        {status === 'success' && (
          <>
            <div style={{
              width: 48, height: 48, borderRadius: '50%',
              background: 'rgba(34,197,94,0.15)',
              border: '1.5px solid rgba(34,197,94,0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 20px',
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <h2 className="text-h2" style={{ marginBottom: 8, color: 'var(--ok)' }}>Account linked!</h2>
            <p className="text-body" style={{ color: 'var(--text-2)', marginBottom: 24 }}>
              Your Telegram is now connected to QWAI. Head back to the bot to access your portfolio, get AI analysis, and trade.
            </p>
            <a
              href={botHref}
              className="btn btn-primary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none', opacity: botUsername ? 1 : 0.6, pointerEvents: botUsername ? 'auto' : 'none' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Back to Bot
            </a>
            <button
              onClick={() => router.push('/dashboard')}
              className="btn btn-ghost"
              style={{ marginLeft: 10 }}
            >
              Dashboard →
            </button>
          </>
        )}

        {status === 'error' && (
          <>
            <div style={{
              width: 48, height: 48, borderRadius: '50%',
              background: 'rgba(239,68,68,0.15)',
              border: '1.5px solid rgba(239,68,68,0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 20px',
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--bad)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </div>
            <h2 className="text-h2" style={{ marginBottom: 8, color: 'var(--bad)' }}>Link failed</h2>
            <p className="text-body" style={{ color: 'var(--text-2)', marginBottom: 24 }}>
              {errMsg}
            </p>
            <button
              onClick={() => router.push('/dashboard')}
              className="btn btn-ghost"
            >
              Back to Dashboard
            </button>
          </>
        )}

        {/* Footer hint */}
        {status !== 'error' && (
          <p className="text-xs" style={{ color: 'var(--text-3)', marginTop: 28 }}>
            Once linked, Telegram and QWAI share the same AI brain, wallets, and agents.
          </p>
        )}
      </div>
    </div>
  );
}

export default function TelegramAuthPage() {
  return (
    <Suspense>
      <TelegramLinkInner />
    </Suspense>
  );
}

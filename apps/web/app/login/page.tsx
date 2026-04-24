'use client';
import { useState } from 'react';
import { ethers } from 'ethers';
import bs58 from 'bs58';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth-store';
import { useRouter } from 'next/navigation';

/**
 * Pick the MetaMask provider specifically. When multiple wallet extensions are
 * installed (Phantom, Coinbase, MetaMask), they all inject into window.ethereum
 * and the default may not be MetaMask. EIP-5749 exposes `providers[]`.
 */
function pickMetaMask(): any | null {
  if (typeof window === 'undefined') return null;
  const eth = (window as any).ethereum;
  if (!eth) return null;
  if (Array.isArray(eth.providers)) {
    return eth.providers.find((p: any) => p.isMetaMask && !p.isBraveWallet) ?? eth.providers[0] ?? null;
  }
  return eth;
}

function pickPhantom(): any | null {
  if (typeof window === 'undefined') return null;
  const sol = (window as any).solana;
  if (sol?.isPhantom) return sol;
  const phantom = (window as any).phantom?.solana;
  return phantom?.isPhantom ? phantom : null;
}

export default function Login() {
  const { setTokens } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'evm' | 'sol'>(null);
  const [err, setErr] = useState<string | null>(null);

  async function evmLogin() {
    if (busy) return;
    setBusy('evm');
    setErr(null);
    try {
      const eth = pickMetaMask();
      if (!eth) {
        setErr('MetaMask not detected. Install from metamask.io');
        return;
      }
      const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
      if (!accounts?.length) {
        setErr('MetaMask returned no accounts. Unlock and try again.');
        return;
      }
      const address = accounts[0];
      const provider = new ethers.BrowserProvider(eth);
      const signer = await provider.getSigner(address);
      const { data: { nonce, message } } = await api.post('/auth/nonce', { address, chain: 'EVM' });
      const signature = await signer.signMessage(message);
      const { data } = await api.post('/auth/verify', { address, chain: 'EVM', signature, nonce });
      setTokens(data.accessToken, data.refreshToken, data.expiresIn);
      router.push('/dashboard');
    } catch (e: any) {
      console.error('[login] evm failed:', e);
      setErr(e?.message || 'Connection failed');
    } finally {
      setBusy(null);
    }
  }

  async function solanaLogin() {
    if (busy) return;
    setBusy('sol');
    setErr(null);
    try {
      const provider = pickPhantom();
      if (!provider) {
        setErr('Phantom not detected. Install from phantom.app');
        return;
      }
      const resp = await provider.connect();
      const address = resp.publicKey.toString();
      const { data: { nonce, message } } = await api.post('/auth/nonce', { address, chain: 'SOLANA' });
      const sig = await provider.signMessage(new TextEncoder().encode(message));
      const { data } = await api.post('/auth/verify', {
        address,
        chain: 'SOLANA',
        signature: bs58.encode(sig.signature),
        nonce,
      });
      setTokens(data.accessToken, data.refreshToken, data.expiresIn);
      router.push('/dashboard');
    } catch (e: any) {
      console.error('[login] solana failed:', e);
      setErr(e?.message || 'Connection failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative flex items-center justify-center px-4 py-8 md:py-12" style={{ minHeight: '70vh' }}>
      <div
        className="cinematic-rise relative z-10 w-full"
        style={{
          maxWidth: 420,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          boxShadow: 'var(--shadow-raised)',
          padding: 22,
        }}
      >
        <div className="flex items-center gap-2.5 mb-5">
          <svg viewBox="0 0 64 64" width="28" height="28" aria-hidden>
            <defs>
              <linearGradient id="login-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="var(--accent)" />
                <stop offset="1" stopColor="var(--accent-2)" />
              </linearGradient>
            </defs>
            <path d="M32 10 L52 22 L52 42 L32 54 L12 42 L12 22 Z" fill="none" stroke="url(#login-grad)" strokeWidth="3.5" strokeLinejoin="round" />
            <circle cx="32" cy="32" r="5" fill="url(#login-grad)" />
            <path d="M36 36 L48 48" stroke="url(#login-grad)" strokeWidth="3.5" strokeLinecap="round" />
          </svg>
          <span className="section-eyebrow">QWAI · Sign in</span>
        </div>

        <h1 className="font-display text-[22px] md:text-[24px] font-semibold tracking-tight mb-1.5">
          Connect your wallet
        </h1>
        <p className="text-[13px] mb-5 leading-relaxed" style={{ color: 'var(--text-2)' }}>
          Sign a message with MetaMask or Phantom to access your dashboard. No password, no email — your wallet is your identity.
        </p>

        <div className="grid gap-2.5">
          <WalletButton kind="evm" label="MetaMask" sub="Ethereum · EVM chains" busy={busy === 'evm'} disabled={!!busy} onClick={evmLogin} />
          <WalletButton kind="sol" label="Phantom"  sub="Solana"                busy={busy === 'sol'} disabled={!!busy} onClick={solanaLogin} />
        </div>

        {err && (
          <div
            className="mt-4 px-3 py-2 rounded-lg text-[12.5px]"
            style={{
              background: 'color-mix(in srgb, var(--bad) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--bad) 40%, var(--border))',
              color: 'var(--bad)',
            }}
          >
            {err}
          </div>
        )}

        <div className="mt-5 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
          <p className="text-[11.5px] font-mono flex items-center gap-2 flex-wrap" style={{ color: 'var(--text-3)' }}>
            <span className="chip chip-ok">
              <span className="live-dot" /> secure
            </span>
            We never see your private keys. Signatures only.
          </p>
        </div>
      </div>
    </div>
  );
}

function WalletButton({
  kind,
  label,
  sub,
  busy,
  disabled,
  onClick,
}: {
  kind: 'evm' | 'sol';
  label: string;
  sub: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const accent = kind === 'evm' ? 'var(--accent)' : 'var(--accent-2)';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group relative w-full flex items-center gap-3 px-3.5 py-2.5 rounded-[10px] text-left transition-all"
      style={{
        background: 'var(--surface-2)',
        border: `1px solid var(--border-2)`,
        color: 'var(--text)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled && !busy ? 0.55 : 1,
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        (e.currentTarget as HTMLElement).style.borderColor = `color-mix(in srgb, ${accent} 55%, var(--border-2))`;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = `var(--border-2)`;
      }}
    >
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
        style={{
          background: `color-mix(in srgb, ${accent} 14%, var(--surface))`,
          border: `1px solid color-mix(in srgb, ${accent} 35%, var(--border))`,
          color: accent,
        }}
      >
        {kind === 'evm' ? <MetaMaskGlyph /> : <PhantomGlyph />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold tracking-tight">{label}</div>
        <div className="text-[11.5px] font-mono" style={{ color: 'var(--text-3)' }}>
          {sub}
        </div>
      </div>
      <div className="flex items-center gap-1.5 font-mono text-[11px]" style={{ color: busy ? accent : 'var(--text-3)' }}>
        {busy ? (
          <>
            <span className="qwai-spinner" style={{ width: 12, height: 12, borderTopColor: accent }} />
            <span>signing…</span>
          </>
        ) : (
          <span style={{ letterSpacing: '0.08em' }}>connect →</span>
        )}
      </div>
    </button>
  );
}

function MetaMaskGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 4 L10 9 L8 13 L4 11 Z" />
      <path d="M20 4 L14 9 L16 13 L20 11 Z" />
      <path d="M8 13 L10 17 L14 17 L16 13" />
      <path d="M4 11 L8 13 M16 13 L20 11" />
    </svg>
  );
}
function PhantomGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 12 A8 8 0 0 1 20 12 V17 A2 2 0 0 1 18 19 H16 V16 A1 1 0 0 0 14 16 V19 H10 V16 A1 1 0 0 0 8 16 V19 H6 A2 2 0 0 1 4 17 Z" />
      <circle cx="10" cy="11" r="1" fill="currentColor" />
      <circle cx="15" cy="11" r="1" fill="currentColor" />
    </svg>
  );
}

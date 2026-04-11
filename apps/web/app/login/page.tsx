'use client';
import { useState } from 'react';
import { ethers } from 'ethers';
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
  const [busy, setBusy] = useState(false);

  async function evmLogin() {
    if (busy) return;
    setBusy(true);
    try {
      const eth = pickMetaMask();
      if (!eth) {
        console.warn('[login] MetaMask not detected. Install https://metamask.io');
        return;
      }
      const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
      if (!accounts?.length) {
        console.warn('[login] MetaMask returned no accounts. Unlock and try again.');
        return;
      }
      const address = accounts[0];
      const provider = new ethers.BrowserProvider(eth);
      const signer = await provider.getSigner(address);
      const { data: { nonce, message } } = await api.post('/auth/nonce', { address, chain: 'EVM' });
      const signature = await signer.signMessage(message);
      const { data } = await api.post('/auth/verify', { address, chain: 'EVM', signature, nonce });
      setTokens(data.accessToken, data.refreshToken);
      router.push('/dashboard');
    } catch (e) {
      console.error('[login] evm failed:', e);
    } finally {
      setBusy(false);
    }
  }

  async function solanaLogin() {
    if (busy) return;
    setBusy(true);
    try {
      const provider = pickPhantom();
      if (!provider) {
        console.warn('[login] Phantom not detected. Install https://phantom.app');
        return;
      }
      const resp = await provider.connect();
      const address = resp.publicKey.toString();
      const { data: { nonce, message } } = await api.post('/auth/nonce', { address, chain: 'SOLANA' });
      const sig = await provider.signMessage(new TextEncoder().encode(message));
      const bs58 = await import('bs58');
      const { data } = await api.post('/auth/verify', {
        address,
        chain: 'SOLANA',
        signature: bs58.default.encode(sig.signature),
        nonce,
      });
      setTokens(data.accessToken, data.refreshToken);
      router.push('/dashboard');
    } catch (e) {
      console.error('[login] solana failed:', e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-md mx-auto py-20">
      <div className="panel">
        <h1 className="text-xl font-semibold tracking-tight mb-1">Connect wallet</h1>
        <p className="text-[13px] text-[color:var(--text-2)] mb-6">
          Sign in with MetaMask or Phantom to access your dashboard.
        </p>
        <div className="grid gap-2">
          <button onClick={evmLogin} disabled={busy} className="btn btn-primary w-full">
            {busy ? 'Connecting…' : 'MetaMask (EVM)'}
          </button>
          <button onClick={solanaLogin} disabled={busy} className="btn w-full">
            {busy ? 'Connecting…' : 'Phantom (Solana)'}
          </button>
        </div>
      </div>
    </div>
  );
}

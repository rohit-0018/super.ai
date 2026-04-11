'use client';
import { useState } from 'react';
import { ethers } from 'ethers';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth-store';
import { useRouter } from 'next/navigation';

export default function Login() {
  const { setTokens } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function evmLogin() {
    setBusy(true); setErr(null);
    try {
      const eth = (window as any).ethereum;
      if (!eth) throw new Error('MetaMask not found');
      const provider = new ethers.BrowserProvider(eth);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      const { data: { nonce, message } } = await api.post('/auth/nonce', { address, chain: 'EVM' });
      const signature = await signer.signMessage(message);
      const { data } = await api.post('/auth/verify', { address, chain: 'EVM', signature, nonce });
      setTokens(data.accessToken, data.refreshToken);
      router.push('/dashboard');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function solanaLogin() {
    setBusy(true); setErr(null);
    try {
      const provider = (window as any).solana;
      if (!provider?.isPhantom) throw new Error('Phantom not found');
      const resp = await provider.connect();
      const address = resp.publicKey.toString();
      const { data: { nonce, message } } = await api.post('/auth/nonce', { address, chain: 'SOLANA' });
      const sig = await provider.signMessage(new TextEncoder().encode(message));
      const bs58 = await import('bs58');
      const { data } = await api.post('/auth/verify', { address, chain: 'SOLANA', signature: bs58.default.encode(sig.signature), nonce });
      setTokens(data.accessToken, data.refreshToken);
      router.push('/dashboard');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-md mx-auto py-16 panel">
      <h1 className="text-2xl font-bold mb-6">Connect Wallet</h1>
      <div className="grid gap-3">
        <button onClick={evmLogin} disabled={busy} className="bg-accent text-black py-3 rounded font-bold">MetaMask (EVM)</button>
        <button onClick={solanaLogin} disabled={busy} className="border border-accent py-3 rounded">Phantom (Solana)</button>
      </div>
      {err && <p className="text-bad mt-4">{err}</p>}
    </div>
  );
}

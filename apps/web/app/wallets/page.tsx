'use client';
import { useState } from 'react';
import { api } from '../../lib/api';
import { useApi, invalidate } from '../../lib/useApi';
import { Skeleton, Spinner } from '../../components/ui/Skeleton';
import CexPortfolio from '../../components/CexPortfolio';

interface Wallet {
  id: string;
  chain: 'SOLANA' | 'EVM';
  address: string;
  isPrimary?: boolean;
  label?: string;
}

export default function Wallets() {
  const { data: wallets, loading } = useApi<Wallet[]>('/wallets');
  const [depositId, setDepositId] = useState<string | null>(null);
  const [withdrawId, setWithdrawId] = useState<string | null>(null);

  async function create(chain: 'SOLANA' | 'EVM') {
    await api.post('/wallets', { chain });
    invalidate('/wallets');
  }

  async function exportKey(id: string) {
    const { data } = await api.post(`/wallets/${id}/export`, {});
    alert('Private key (store offline):\n\n' + data.key);
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Wallets</h1>
          <p className="text-[13px] text-[color:var(--text-2)] mt-1">
            Manage connected wallets across Solana and EVM chains.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => create('SOLANA')} className="btn">+ Solana</button>
          <button onClick={() => create('EVM')} className="btn">+ EVM</button>
        </div>
      </header>

      <div className="panel !p-0 overflow-hidden">
        <div className="px-5 py-3 border-b border-border">
          <h3 className="section-title">On-chain wallets</h3>
        </div>
        {loading && !wallets ? (
          <ul className="divide-y divide-border">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-3 flex-1">
                  <Skeleton w={48} h={20} rounded="md" />
                  <Skeleton w="40%" h={12} />
                </div>
                <Skeleton w={80} h={24} rounded="md" />
              </li>
            ))}
          </ul>
        ) : !wallets || wallets.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-[13px] text-[color:var(--text-3)]">No wallets yet</p>
          </div>
        ) : (
          <ul className="divide-y divide-border fade-in">
            {wallets.map((w) => (
              <li key={w.id} className="px-5 py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="chip">{w.chain}</span>
                    {w.isPrimary && (
                      <span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: 'var(--accent)' }}>
                        Primary
                      </span>
                    )}
                    <span className="font-mono text-[13px] text-[color:var(--text-2)] truncate">
                      {w.address}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setDepositId(depositId === w.id ? null : w.id)}
                      className="btn btn-sm"
                    >
                      Deposit
                    </button>
                    <button
                      onClick={() => setWithdrawId(withdrawId === w.id ? null : w.id)}
                      className="btn btn-sm"
                    >
                      Withdraw
                    </button>
                    <button
                      onClick={() => exportKey(w.id)}
                      className="btn btn-sm"
                      style={{ color: 'var(--bad)' }}
                    >
                      Export key
                    </button>
                  </div>
                </div>

                {depositId === w.id && (
                  <DepositPanel wallet={w} />
                )}
                {withdrawId === w.id && (
                  <WithdrawPanel wallet={w} onDone={() => setWithdrawId(null)} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <CexPortfolio />
    </div>
  );
}

function DepositPanel({ wallet }: { wallet: Wallet }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div className="mt-3 p-4 rounded-lg fade-in" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      <div className="text-[12px] font-medium mb-2">
        Deposit {wallet.chain === 'SOLANA' ? 'SOL / SPL tokens' : 'ETH / ERC-20 tokens'}
      </div>
      <div className="flex items-center gap-2 mb-2">
        <code className="flex-1 text-[12px] font-mono bg-[color:var(--bg)] border border-border rounded-md px-3 py-2 truncate select-all">
          {wallet.address}
        </code>
        <button onClick={copy} className="btn btn-sm btn-primary">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="text-[11px] text-[color:var(--text-3)]">
        {wallet.chain === 'SOLANA'
          ? 'Send SOL or SPL tokens to this address. Funds arrive in ~400ms.'
          : 'Send ETH or ERC-20 tokens to this address. Wait for block confirmation.'}
      </p>
    </div>
  );
}

function WithdrawPanel({ wallet, onDone }: { wallet: Wallet; onDone: () => void }) {
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function submit() {
    if (!toAddress.trim() || !amount.trim()) { setError('Address and amount required'); return; }
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post(`/wallets/${wallet.id}/withdraw`, {
        toAddress: toAddress.trim(),
        tokenMint: 'native',
        amount: parseFloat(amount),
      });
      setResult(`Sent. TX: ${data.txHash.slice(0, 12)}…`);
      invalidate('/wallets');
      setTimeout(onDone, 2000);
    } catch (e: any) {
      setError(e?.message ?? 'Withdraw failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 p-4 rounded-lg fade-in" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      <div className="text-[12px] font-medium mb-3">
        Withdraw {wallet.chain === 'SOLANA' ? 'SOL' : 'ETH'} (native)
      </div>
      <div className="space-y-2">
        <input
          value={toAddress}
          onChange={(e) => setToAddress(e.target.value)}
          placeholder="Destination address"
          className="input font-mono"
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={`Amount in ${wallet.chain === 'SOLANA' ? 'SOL' : 'ETH'}`}
          inputMode="decimal"
          className="input font-mono"
        />
        {error && <p className="text-[12px]" style={{ color: 'var(--bad)' }}>{error}</p>}
        {result && <p className="text-[12px]" style={{ color: 'var(--ok)' }}>{result}</p>}
        <button onClick={submit} disabled={busy} className="btn btn-primary btn-sm">
          {busy ? <Spinner size={12} /> : 'Send'}
        </button>
      </div>
    </div>
  );
}

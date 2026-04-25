'use client';
import { useState } from 'react';
import { api } from '../../lib/api';
import { useApi, invalidate } from '../../lib/useApi';
import { Skeleton, Spinner } from '../../components/ui/Skeleton';
import CexPortfolio from '../../components/CexPortfolio';

interface WalletBalance {
  walletId: string;
  native: number;
  symbol: string;
  usd: number;
  error?: string;
}

interface Wallet {
  id: string;
  chain: 'SOLANA' | 'EVM';
  address: string;
  isPrimary?: boolean;
  label?: string;
  paperBalance?: number | null;
  recentTrades?: { tokenIn: string; tokenOut: string; amountIn: string; amountOut: string; priceUsd: number | null; mode: string; createdAt: string }[];
}

export default function Wallets() {
  const { data: wallets, loading } = useApi<Wallet[]>('/wallets');
  const { data: balances, loading: balLoading } = useApi<WalletBalance[]>('/wallets/balances');
  const [depositId, setDepositId] = useState<string | null>(null);
  const [withdrawId, setWithdrawId] = useState<string | null>(null);

  const balMap = new Map<string, WalletBalance>();
  balances?.forEach((b) => balMap.set(b.walletId, b));

  async function create(chain: 'SOLANA' | 'EVM') {
    await api.post('/wallets', { chain });
    invalidate('/wallets');
  }

  async function exportKey(id: string) {
    const { data } = await api.post(`/wallets/${id}/export`, {});
    alert('Private key (store offline):\n\n' + data.key);
  }

  async function setPrimary(id: string) {
    await api.post(`/wallets/${id}/primary`, {});
    invalidate('/wallets');
  }

  const totalUsd = balances?.reduce((s, b) => s + (b.usd ?? 0), 0) ?? 0;
  const isTestnet = process.env.NEXT_PUBLIC_NETWORK_MODE === 'testnet';

  return (
    <div className="page space-y-4">
      <header className="page-header">
        <div>
          <div className="section-eyebrow">Wallets</div>
          <h1 className="page-title">On-chain wallets</h1>
          <p className="page-subtitle">
            Manage wallets across Solana and EVM.
            {isTestnet && <span className="ml-2 chip chip-warn">devnet / Sepolia</span>}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <a href="/wallets/analyze" className="btn btn-primary">Analyze wallet →</a>
          <button onClick={() => create('SOLANA')} className="btn">+ Solana</button>
          <button onClick={() => create('EVM')} className="btn">+ EVM</button>
        </div>
      </header>

      {/* Total portfolio value */}
      <section className="section">
        <div className="section-body flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="stat-label mb-1">Total on-chain value</div>
            {balLoading && !balances ? (
              <Skeleton w={180} h={32} />
            ) : (
              <div className="stat-value fade-in">
                ${totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
            )}
          </div>
          <div className="text-right">
            <div className="stat-label mb-1">Wallets</div>
            {loading ? (
              <Skeleton w={40} h={20} />
            ) : (
              <div className="text-[15px] font-mono fade-in">{wallets?.length ?? 0}</div>
            )}
          </div>
        </div>
      </section>

      {/* Wallet list */}
      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Wallets</h3>
          <button onClick={() => { invalidate('/wallets'); invalidate('/wallets/balances'); }} className="btn btn-ghost btn-sm">Refresh</button>
        </div>
        {loading && !wallets ? (
          <ul className="divide-y divide-border">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="px-5 py-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1">
                    <Skeleton w={48} h={22} rounded="md" />
                    <Skeleton w="30%" h={14} />
                  </div>
                  <div className="flex items-center gap-3">
                    <Skeleton w={100} h={16} />
                    <Skeleton w={80} h={28} rounded="md" />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : !wallets || wallets.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-[13px] text-[color:var(--text-3)] mb-2">No wallets yet</p>
            <p className="text-[11px] text-[color:var(--text-3)]">Create a Solana or EVM wallet to start trading</p>
          </div>
        ) : (
          <ul className="divide-y divide-border fade-in">
            {wallets.map((w) => (
              <li key={w.id} className="px-3.5 md:px-5 py-4">
                {/* Row 1: chain + address + balance + actions */}
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center text-[12px] font-semibold shrink-0"
                      style={{
                        background: w.chain === 'SOLANA'
                          ? 'linear-gradient(135deg, #9945FF 0%, #14F195 100%)'
                          : 'linear-gradient(135deg, #627EEA 0%, #3C3C3D 100%)',
                        color: 'white',
                      }}
                    >
                      {w.chain === 'SOLANA' ? 'SOL' : 'ETH'}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-[12.5px] truncate max-w-[120px] md:max-w-[260px]">{w.address}</span>
                        {w.isPrimary && (
                          <span className="chip chip-accent">Primary</span>
                        )}
                      </div>
                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>
                        {w.chain} · {isTestnet ? (w.chain === 'SOLANA' ? 'devnet' : 'Sepolia') : 'mainnet'}
                      </div>
                    </div>
                  </div>

                  {/* Balance */}
                  <div className="text-right">
                    {(() => {
                      const bal = balMap.get(w.id);
                      if (bal && !bal.error) {
                        return (
                          <div className="fade-in">
                            <div className="font-mono text-[15px] font-semibold">
                              {bal.native.toLocaleString(undefined, { maximumFractionDigits: 6 })} {bal.symbol}
                            </div>
                            <div className="font-mono text-[11px] text-[color:var(--text-3)]">
                              ${bal.usd.toFixed(2)}
                            </div>
                          </div>
                        );
                      }
                      if (balLoading && !balances) {
                        return (
                          <div className="space-y-1.5">
                            <Skeleton w={110} h={16} />
                            <Skeleton w={70} h={10} />
                          </div>
                        );
                      }
                      if (bal?.error) {
                        return <div className="text-[11px] text-[color:var(--text-3)]">Balance unavailable</div>;
                      }
                      return (
                        <div className="space-y-1.5">
                          <Skeleton w={110} h={16} />
                          <Skeleton w={70} h={10} />
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* Row 2: action buttons */}
                <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                  {isTestnet && w.chain === 'SOLANA' && (
                    <FaucetButton walletId={w.id} />
                  )}
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
                  {!w.isPrimary && (
                    <button onClick={() => setPrimary(w.id)} className="btn btn-sm btn-ghost">
                      Set primary
                    </button>
                  )}
                  <button
                    onClick={() => exportKey(w.id)}
                    className="btn btn-sm btn-ghost"
                    style={{ color: 'var(--bad)' }}
                  >
                    Export key
                  </button>
                </div>

                {depositId === w.id && <DepositPanel wallet={w} />}
                {withdrawId === w.id && <WithdrawPanel wallet={w} bal={balMap.get(w.id)} onDone={() => setWithdrawId(null)} />}

                {/* Recent trades for this wallet */}
                {w.recentTrades && w.recentTrades.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-[color:var(--border)]">
                    <div className="text-[10px] uppercase tracking-wider text-[color:var(--text-3)] mb-2 font-medium">Recent activity</div>
                    <div className="space-y-1">
                      {w.recentTrades.map((t, i) => (
                        <div key={i} className="flex items-center justify-between text-[11px]">
                          <div className="flex items-center gap-2">
                            <span className="chip" style={{ fontSize: 9, height: 18 }}>{t.mode}</span>
                            <span className="font-mono text-[color:var(--text-2)]">
                              {t.amountIn} {t.tokenIn.slice(0, 6)} → {t.amountOut} {t.tokenOut.slice(0, 6)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            {t.priceUsd != null && (
                              <span className="font-mono text-[color:var(--text-3)]">${Number(t.priceUsd).toFixed(2)}</span>
                            )}
                            <span className="text-[color:var(--text-3)]">
                              {new Date(t.createdAt).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

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

function WithdrawPanel({ wallet, bal, onDone }: { wallet: Wallet; bal?: WalletBalance; onDone: () => void }) {
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
      <div className="text-[12px] font-medium mb-2">
        Withdraw {wallet.chain === 'SOLANA' ? 'SOL' : 'ETH'} (native)
        {bal && (
          <span className="text-[color:var(--text-3)] ml-2">
            Available: {bal.native.toLocaleString(undefined, { maximumFractionDigits: 6 })} {bal.symbol}
          </span>
        )}
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

function FaucetButton({ walletId }: { walletId: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string; address?: string } | null>(null);

  async function requestFaucet() {
    setBusy(true);
    setResult(null);
    try {
      const { data } = await api.post(`/wallets/${walletId}/faucet`, {});
      setResult(data);
      if (data.success) invalidate('/wallets');
    } catch (e: any) {
      setResult({ success: false, message: e?.message ?? 'Faucet failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <button onClick={requestFaucet} disabled={busy} className="btn btn-sm" style={{ color: 'var(--ok)', borderColor: 'color-mix(in srgb, var(--ok) 40%, var(--border))' }}>
        {busy ? 'Airdropping…' : 'Faucet'}
      </button>
      {result && !result.success && (
        <a
          href="https://faucet.solana.com"
          target="_blank"
          rel="noreferrer"
          className="btn btn-sm btn-primary"
        >
          Open Solana Faucet
        </a>
      )}
      {result?.success && (
        <span className="text-[10px]" style={{ color: 'var(--ok)' }}>{result.message}</span>
      )}
    </div>
  );
}

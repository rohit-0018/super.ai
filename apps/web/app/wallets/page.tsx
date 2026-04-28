'use client';
import { useState, useEffect, useRef } from 'react';
import { api } from '../../lib/api';
import { useApi, invalidate } from '../../lib/useApi';
import { Skeleton, Spinner } from '../../components/ui/Skeleton';
import CexPortfolio from '../../components/CexPortfolio';

interface WalletBalance {
  walletId: string;
  native: number;
  symbol: string;
  usd: number;
  tokens?: Array<{ mint: string; symbol: string; amount: number; usd: number }>;
  error?: string;
}

interface Wallet {
  id: string;
  chain: 'SOLANA' | 'EVM';
  address: string;
  isPrimary?: boolean;
  isImported?: boolean;
  backedUpAt?: string | null;
  label?: string;
  paperBalance?: number | null;
  recentTrades?: { tokenIn: string; tokenOut: string; amountIn: string; amountOut: string; priceUsd: number | null; mode: string; createdAt: string }[];
}

export default function Wallets() {
  const { data: wallets, loading } = useApi<Wallet[]>('/wallets');
  const { data: balances, loading: balLoading } = useApi<WalletBalance[]>('/wallets/balances');
  const [depositId, setDepositId] = useState<string | null>(null);
  const [withdrawId, setWithdrawId] = useState<string | null>(null);
  const [exportTarget, setExportTarget] = useState<{ id: string; address: string; chain: string } | null>(null);
  const [newWallet, setNewWallet] = useState<{ id: string; address: string; chain: string; privateKey: string } | null>(null);
  const [showImport, setShowImport] = useState(false);

  const balMap = new Map<string, WalletBalance>();
  balances?.forEach((b) => balMap.set(b.walletId, b));

  async function create(chain: 'SOLANA' | 'EVM') {
    const { data } = await api.post('/wallets', { chain });
    invalidate('/wallets');
    // Show mandatory backup modal with the one-time private key
    setNewWallet({ id: data.id, address: data.address, chain: data.chain, privateKey: data.privateKey });
  }

  function openExport(wallet: Wallet) {
    setExportTarget({ id: wallet.id, address: wallet.address, chain: wallet.chain });
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
        <div className="flex gap-2 flex-wrap w-full sm:w-auto">
          <a href="/wallets/analyze" className="btn btn-primary flex-1 sm:flex-none">Analyze wallet →</a>
          <button onClick={() => create('SOLANA')} className="btn flex-1 sm:flex-none">+ Solana</button>
          <button onClick={() => create('EVM')} className="btn flex-1 sm:flex-none">+ EVM</button>
          <button onClick={() => setShowImport(true)} className="btn btn-ghost flex-1 sm:flex-none">Import key</button>
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
                        {w.isImported && (
                          <span className="chip" style={{ fontSize: 9, background: 'color-mix(in srgb, var(--accent-2) 12%, var(--surface-2))', color: 'var(--accent-2)', borderColor: 'color-mix(in srgb, var(--accent-2) 30%, transparent)' }}>Imported</span>
                        )}
                        {!w.backedUpAt && !w.isImported && (
                          <span
                            className="chip chip-warn"
                            title="Key not backed up — click Export key and save it offline"
                            style={{ fontSize: 9, cursor: 'help' }}
                          >
                            ⚠ Backup key
                          </span>
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
                      // Still fetching initial load
                      if (balLoading && !balances) {
                        return (
                          <div className="space-y-1.5">
                            <Skeleton w={110} h={16} />
                            <Skeleton w={70} h={10} />
                          </div>
                        );
                      }
                      // RPC error or wallet not in response
                      if (!bal || bal.error) {
                        return (
                          <div className="fade-in">
                            <div className="text-[11px] font-medium" style={{ color: 'var(--bad)' }}>
                              Balance fetch failed
                            </div>
                            <button
                              onClick={() => invalidate('/wallets/balances')}
                              className="btn btn-ghost btn-sm mt-0.5"
                              style={{ fontSize: 10, height: 20, padding: '0 6px' }}
                            >
                              Retry
                            </button>
                          </div>
                        );
                      }
                      // Success — show native + any SPL tokens
                      return (
                        <div className="fade-in">
                          <div className="font-mono text-[15px] font-semibold">
                            {bal.native.toLocaleString(undefined, { maximumFractionDigits: 6 })} {bal.symbol}
                          </div>
                          <div className="font-mono text-[11px]" style={{ color: 'var(--text-3)' }}>
                            ${bal.usd.toFixed(2)}
                          </div>
                          {bal.tokens && bal.tokens.map((t) => (
                            <div key={t.mint} className="font-mono text-[11px] mt-0.5" style={{ color: 'var(--text-2)' }}>
                              {t.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} {t.symbol}
                              {t.usd > 0 && (
                                <span style={{ color: 'var(--text-3)' }}> · ${t.usd.toFixed(2)}</span>
                              )}
                            </div>
                          ))}
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
                    onClick={() => {
                      const closing = depositId === w.id;
                      setDepositId(closing ? null : w.id);
                      if (closing) invalidate('/wallets/balances');
                    }}
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
                    onClick={() => openExport(w)}
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
                        <div key={i} className="flex items-start justify-between gap-2 text-[11px] flex-wrap">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="chip shrink-0" style={{ fontSize: 9, height: 18 }}>{t.mode}</span>
                            <span className="font-mono text-[color:var(--text-2)] truncate">
                              {t.amountIn} {t.tokenIn.slice(0, 6)} → {t.amountOut} {t.tokenOut.slice(0, 6)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
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

      {newWallet && (
        <NewWalletBackupModal
          walletId={newWallet.id}
          address={newWallet.address}
          chain={newWallet.chain}
          privateKey={newWallet.privateKey}
          onClose={() => { setNewWallet(null); invalidate('/wallets'); }}
        />
      )}

      {exportTarget && (
        <ExportKeyModal
          walletId={exportTarget.id}
          address={exportTarget.address}
          chain={exportTarget.chain}
          onClose={() => { setExportTarget(null); invalidate('/wallets'); }}
        />
      )}

      {showImport && (
        <ImportWalletModal
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); invalidate('/wallets'); invalidate('/wallets/balances'); }}
        />
      )}
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
      <div className="flex items-center gap-2 mb-2 flex-wrap sm:flex-nowrap">
        <code className="w-full sm:flex-1 text-[12px] font-mono bg-[color:var(--bg)] border border-border rounded-md px-3 py-2 truncate select-all break-all">
          {wallet.address}
        </code>
        <button onClick={copy} className="btn btn-sm btn-primary w-full sm:w-auto">
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

// ─── Shared helpers ───────────────────────────────────────────────────────────

function downloadKeyFile(chain: string, address: string, privateKey: string) {
  const content = [
    'qwai Wallet Backup',
    '==================',
    `Chain:       ${chain}`,
    `Address:     ${address}`,
    `Private Key: ${privateKey}`,
    `Format:      ${chain === 'SOLANA' ? 'base58' : 'hex (0x-prefixed)'}`,
    `Exported:    ${new Date().toISOString()}`,
    '',
    'WARNING: Anyone with this file can drain all funds from this wallet.',
    'Store it encrypted and offline. Never share it or upload it anywhere.',
  ].join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `qwai-wallet-${address.slice(0, 8)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function ChainBadge({ chain }: { chain: string }) {
  return (
    <div
      className="w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-semibold shrink-0"
      style={{
        background: chain === 'SOLANA'
          ? 'linear-gradient(135deg, #9945FF 0%, #14F195 100%)'
          : 'linear-gradient(135deg, #627EEA 0%, #3C3C3D 100%)',
        color: 'white',
      }}
    >
      {chain === 'SOLANA' ? 'SOL' : 'ETH'}
    </div>
  );
}

function ModalShell({ title, titleColor, onClose, children }: {
  title: string;
  titleColor?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-md rounded-[14px] fade-in"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border-2)',
          boxShadow: 'inset 0 1px 0 var(--highlight), 0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        <div
          className="flex items-center justify-between px-5 py-3.5"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <span className="text-[13px] font-semibold" style={{ color: titleColor ?? 'var(--text)' }}>{title}</span>
          <button
            onClick={onClose}
            className="btn btn-ghost btn-sm"
            style={{ width: 28, height: 28, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M1 1l12 12M13 1L1 13" />
            </svg>
          </button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
      </div>
    </div>
  );
}

function KeyRevealBox({ privateKey, chain }: { privateKey: string; chain: string }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(privateKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      ref.current?.select();
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-widest font-medium" style={{ color: 'var(--text-3)' }}>
        Private key — {chain === 'SOLANA' ? 'base58' : 'hex'}
      </div>
      <div className="rounded-[10px] p-3" style={{ background: 'var(--bg)', border: '1px solid var(--border-2)' }}>
        <textarea
          ref={ref}
          readOnly
          value={privateKey}
          rows={3}
          onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          className="w-full bg-transparent font-mono text-[12px] resize-none outline-none leading-relaxed break-all"
          style={{ color: 'var(--text)', caretColor: 'transparent' }}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="flex gap-2">
        <button onClick={copy} className="btn btn-primary btn-sm flex-1">
          {copied ? (
            <span className="flex items-center gap-1.5 justify-center">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 6l3 3 5-5" />
              </svg>
              Copied
            </span>
          ) : 'Copy to clipboard'}
        </button>
        <button
          onClick={() => downloadKeyFile(chain, '', privateKey)}
          className="btn btn-sm"
          style={{ border: '1px solid var(--border-2)' }}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', marginRight: 5 }}>
            <path d="M6.5 1v8M3 6l3.5 3.5L10 6" /><path d="M1 11h11" />
          </svg>
          Download .txt
        </button>
      </div>
    </div>
  );
}

// ─── New Wallet Backup Modal ──────────────────────────────────────────────────
// Shown immediately after wallet creation. Cannot be fully closed without
// the user confirming they've saved the key.

function NewWalletBackupModal({
  walletId,
  address,
  chain,
  privateKey,
  onClose,
}: {
  walletId: string;
  address: string;
  chain: string;
  privateKey: string;
  onClose: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  function handleDownload() {
    downloadKeyFile(chain, address, privateKey);
    setDownloaded(true);
    // Mark backed up server-side
    api.post(`/wallets/${walletId}/confirm-backup`, {}).catch(() => {});
  }

  function handleClose() {
    if (!confirmed) return;
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(6px)' }}
    >
      <div
        className="w-full max-w-md rounded-[14px] fade-in"
        style={{
          background: 'var(--surface)',
          border: '1px solid color-mix(in srgb, var(--warn) 40%, var(--border-2))',
          boxShadow: 'inset 0 1px 0 var(--highlight), 0 24px 80px rgba(0,0,0,0.7)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2.5 px-5 py-3.5"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--warn)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 1L1 13h14L8 1z" /><path d="M8 6v3.5M8 11.5v.5" />
          </svg>
          <span className="text-[13px] font-semibold" style={{ color: 'var(--warn)' }}>
            Back up your private key before continuing
          </span>
        </div>

        <div className="p-5 space-y-4">
          {/* Wallet identity row */}
          <div
            className="flex items-center gap-3 px-3 py-2.5 rounded-[10px]"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
          >
            <ChainBadge chain={chain} />
            <div className="min-w-0">
              <div className="font-mono text-[12px] truncate" style={{ color: 'var(--text-2)' }}>{address}</div>
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-3)' }}>New {chain} wallet · not backed up yet</div>
            </div>
          </div>

          {/* Critical notice */}
          <div
            className="rounded-[10px] px-4 py-3 space-y-1.5"
            style={{ background: 'color-mix(in srgb, var(--bad) 8%, var(--surface-2))', border: '1px solid color-mix(in srgb, var(--bad) 30%, transparent)' }}
          >
            <div className="text-[12px] font-semibold" style={{ color: 'var(--bad)' }}>This is the only time qwai shows you this key</div>
            <ul className="space-y-1">
              {[
                'If you skip this step and the database is wiped, your funds are gone permanently.',
                'This key is shown nowhere else in the UI after you close this window.',
                'Download the .txt file and store it offline — password manager, USB drive, paper.',
              ].map((t) => (
                <li key={t} className="flex items-start gap-2 text-[12px]" style={{ color: 'var(--text-2)' }}>
                  <span style={{ color: 'var(--bad)', marginTop: 1 }}>·</span>{t}
                </li>
              ))}
            </ul>
          </div>

          <KeyRevealBox privateKey={privateKey} chain={chain} />

          {/* Download shortcut — prominent CTA */}
          <button
            onClick={handleDownload}
            className="btn btn-sm w-full"
            style={{
              background: downloaded
                ? 'color-mix(in srgb, var(--ok) 15%, var(--surface-2))'
                : 'color-mix(in srgb, var(--warn) 15%, var(--surface-2))',
              border: `1px solid color-mix(in srgb, ${downloaded ? 'var(--ok)' : 'var(--warn)'} 40%, transparent)`,
              color: downloaded ? 'var(--ok)' : 'var(--warn)',
            }}
          >
            {downloaded ? (
              <span className="flex items-center gap-1.5 justify-center">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 6l3 3 5-5" />
                </svg>
                Downloaded — save it somewhere safe offline
              </span>
            ) : (
              <span className="flex items-center gap-1.5 justify-center">
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6.5 1v8M3 6l3.5 3.5L10 6" /><path d="M1 11h11" />
                </svg>
                Download key file (.txt)
              </span>
            )}
          </button>

          {/* Confirmation checkbox + close */}
          <div
            className="flex items-start gap-3 px-3 py-3 rounded-[10px] cursor-pointer select-none"
            style={{ background: 'var(--surface-2)', border: `1px solid ${confirmed ? 'color-mix(in srgb, var(--ok) 40%, transparent)' : 'var(--border)'}` }}
            onClick={() => setConfirmed((v) => !v)}
          >
            <div
              className="w-4 h-4 rounded shrink-0 mt-0.5 flex items-center justify-center"
              style={{
                border: `1.5px solid ${confirmed ? 'var(--ok)' : 'var(--text-3)'}`,
                background: confirmed ? 'var(--ok)' : 'transparent',
                transition: 'all 0.15s',
              }}
            >
              {confirmed && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="black" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1.5 5l2.5 2.5 4.5-4.5" />
                </svg>
              )}
            </div>
            <span className="text-[12px]" style={{ color: 'var(--text-2)' }}>
              I have saved my private key offline. I understand that qwai cannot recover it if I lose access to the database.
            </span>
          </div>

          <button
            onClick={handleClose}
            disabled={!confirmed}
            className="btn btn-primary btn-sm w-full"
            style={{ opacity: confirmed ? 1 : 0.4, cursor: confirmed ? 'pointer' : 'not-allowed' }}
          >
            {confirmed ? "I've backed it up — continue" : 'Check the box above to continue'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Import Wallet Modal ──────────────────────────────────────────────────────

function ImportWalletModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [chain, setChain] = useState<'SOLANA' | 'EVM'>('SOLANA');
  const [privateKey, setPrivateKey] = useState('');
  const [label, setLabel] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit() {
    if (!privateKey.trim()) { setError('Private key required'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post('/wallets/import', { chain, privateKey: privateKey.trim(), label: label.trim() || undefined });
      onImported();
    } catch (e: any) {
      setError(e?.message ?? 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-md rounded-[14px] fade-in"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border-2)',
          boxShadow: 'inset 0 1px 0 var(--highlight), 0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        <div
          className="flex items-center justify-between px-5 py-3.5"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>Import wallet by private key</span>
          <button
            onClick={onClose}
            className="btn btn-ghost btn-sm"
            style={{ width: 28, height: 28, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M1 1l12 12M13 1L1 13" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-[12px]" style={{ color: 'var(--text-2)' }}>
            Paste the private key of an existing wallet. qwai will encrypt and store it — you can use it for trading without ever entering the key again.
          </p>

          {/* Chain toggle */}
          <div className="flex gap-1 p-1 rounded-[10px]" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
            {(['SOLANA', 'EVM'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setChain(c)}
                className="flex-1 text-[12px] font-medium rounded-[8px] py-1.5 transition-all"
                style={{
                  background: chain === c ? 'var(--surface-hover)' : 'transparent',
                  color: chain === c ? 'var(--text)' : 'var(--text-3)',
                  border: chain === c ? '1px solid var(--border-2)' : '1px solid transparent',
                }}
              >
                {c === 'SOLANA' ? 'Solana (base58)' : 'EVM (0x hex)'}
              </button>
            ))}
          </div>

          {/* Private key input */}
          <div className="space-y-1.5">
            <div className="text-[11px] uppercase tracking-widest font-medium" style={{ color: 'var(--text-3)' }}>Private key</div>
            <div className="relative">
              <textarea
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder={chain === 'SOLANA' ? 'base58 encoded key…' : '0x… or hex…'}
                rows={3}
                autoComplete="off"
                spellCheck={false}
                className="input w-full font-mono text-[12px] resize-none leading-relaxed break-all"
                style={{
                  paddingRight: 40,
                  filter: showKey ? 'none' : 'blur(4px)',
                  userSelect: showKey ? 'auto' : 'none',
                }}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-2 btn btn-ghost btn-sm"
                style={{ width: 28, height: 28, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                title={showKey ? 'Hide' : 'Reveal'}
              >
                {showKey ? (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 7s2.5-4.5 6-4.5S13 7 13 7s-2.5 4.5-6 4.5S1 7 1 7z" />
                    <circle cx="7" cy="7" r="1.5" />
                    <path d="M1 1l12 12" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 7s2.5-4.5 6-4.5S13 7 13 7s-2.5 4.5-6 4.5S1 7 1 7z" />
                    <circle cx="7" cy="7" r="1.5" />
                  </svg>
                )}
              </button>
            </div>
            {!showKey && privateKey.length > 0 && (
              <p className="text-[10px]" style={{ color: 'var(--text-3)' }}>Key hidden — click the eye icon to reveal</p>
            )}
          </div>

          {/* Optional label */}
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional, e.g. Trading wallet)"
            className="input text-[12px]"
          />

          {error && <p className="text-[12px]" style={{ color: 'var(--bad)' }}>{error}</p>}

          <div
            className="flex items-start gap-2 px-3 py-2.5 rounded-[8px]"
            style={{ background: 'color-mix(in srgb, var(--accent) 8%, var(--surface-2))', border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)' }}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: 1, flexShrink: 0 }}>
              <circle cx="6.5" cy="6.5" r="5.5" /><path d="M6.5 4v3M6.5 9v.5" />
            </svg>
            <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>
              Your key is encrypted with AES-256-GCM and stored only on this server. It is never sent elsewhere.
            </span>
          </div>

          <div className="flex gap-2">
            <button onClick={onClose} className="btn btn-ghost btn-sm flex-1">Cancel</button>
            <button onClick={submit} disabled={busy || !privateKey.trim()} className="btn btn-primary btn-sm flex-1">
              {busy ? <Spinner size={12} /> : 'Import wallet'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExportKeyModal({
  walletId,
  address,
  chain,
  onClose,
}: {
  walletId: string;
  address: string;
  chain: string;
  onClose: () => void;
}) {
  type Stage = 'confirm' | 'loading' | 'revealed' | 'error';
  const [stage, setStage] = useState<Stage>('confirm');
  const [privateKey, setPrivateKey] = useState('');
  const [copied, setCopied] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const keyRef = useRef<HTMLTextAreaElement>(null);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function reveal() {
    setStage('loading');
    try {
      const { data } = await api.post(`/wallets/${walletId}/export`, {});
      setPrivateKey(data.key);
      setStage('revealed');
      setTimeout(() => keyRef.current?.select(), 80);
      // Mark backed up so the warning badge clears
      api.post(`/wallets/${walletId}/confirm-backup`, {}).catch(() => {});
    } catch (e: any) {
      setErrorMsg(e?.message ?? 'Failed to export key');
      setStage('error');
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(privateKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      keyRef.current?.select();
    }
  }

  function handleClose() {
    // Zero the key string before unmounting
    setPrivateKey('');
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="w-full max-w-md rounded-[14px] fade-in"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border-2)',
          boxShadow: 'inset 0 1px 0 var(--highlight), 0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3.5"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-2.5">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--bad)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 1L1 13h14L8 1z" />
              <path d="M8 6v3.5M8 11.5v.5" />
            </svg>
            <span className="text-[13px] font-semibold" style={{ color: 'var(--bad)' }}>Export private key</span>
          </div>
          <button
            onClick={handleClose}
            className="btn btn-ghost btn-sm"
            style={{ width: 28, height: 28, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M1 1l12 12M13 1L1 13" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Wallet identity */}
          <div
            className="flex items-center gap-3 px-3 py-2.5 rounded-[10px]"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
          >
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-semibold shrink-0"
              style={{
                background: chain === 'SOLANA'
                  ? 'linear-gradient(135deg, #9945FF 0%, #14F195 100%)'
                  : 'linear-gradient(135deg, #627EEA 0%, #3C3C3D 100%)',
                color: 'white',
              }}
            >
              {chain === 'SOLANA' ? 'SOL' : 'ETH'}
            </div>
            <span className="font-mono text-[12px] truncate" style={{ color: 'var(--text-2)' }}>{address}</span>
          </div>

          {stage === 'confirm' && (
            <>
              {/* Warning block */}
              <div
                className="rounded-[10px] px-4 py-3 space-y-1.5"
                style={{ background: 'color-mix(in srgb, var(--bad) 8%, var(--surface-2))', border: '1px solid color-mix(in srgb, var(--bad) 30%, transparent)' }}
              >
                <div className="text-[12px] font-semibold" style={{ color: 'var(--bad)' }}>Never share your private key</div>
                <ul className="space-y-1">
                  {[
                    'Anyone with this key controls all funds in this wallet — permanently.',
                    'qwai support will never ask for it.',
                    'Save it offline, in cold storage, not in notes or messages.',
                  ].map((t) => (
                    <li key={t} className="flex items-start gap-2 text-[12px]" style={{ color: 'var(--text-2)' }}>
                      <span style={{ color: 'var(--bad)', marginTop: 1 }}>·</span>
                      {t}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex gap-2 pt-1">
                <button onClick={handleClose} className="btn btn-ghost btn-sm flex-1">Cancel</button>
                <button
                  onClick={reveal}
                  className="btn btn-sm flex-1"
                  style={{
                    background: 'color-mix(in srgb, var(--bad) 15%, var(--surface-2))',
                    border: '1px solid color-mix(in srgb, var(--bad) 40%, transparent)',
                    color: 'var(--bad)',
                  }}
                >
                  I understand — reveal key
                </button>
              </div>
            </>
          )}

          {stage === 'loading' && (
            <div className="flex items-center justify-center py-8 gap-3" style={{ color: 'var(--text-3)' }}>
              <Spinner size={16} />
              <span className="text-[13px]">Decrypting…</span>
            </div>
          )}

          {stage === 'error' && (
            <div className="space-y-3">
              <p className="text-[13px]" style={{ color: 'var(--bad)' }}>{errorMsg}</p>
              <button onClick={handleClose} className="btn btn-sm btn-ghost">Close</button>
            </div>
          )}

          {stage === 'revealed' && (
            <>
              <div className="space-y-2">
                <div className="text-[11px] uppercase tracking-widest font-medium" style={{ color: 'var(--text-3)' }}>
                  Private key — {chain === 'SOLANA' ? 'base58' : 'hex'}
                </div>
                <div
                  className="rounded-[10px] p-3"
                  style={{ background: 'var(--bg)', border: '1px solid var(--border-2)' }}
                >
                  <textarea
                    ref={keyRef}
                    readOnly
                    value={privateKey}
                    rows={3}
                    onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                    className="w-full bg-transparent font-mono text-[12px] resize-none outline-none leading-relaxed break-all"
                    style={{ color: 'var(--text)', caretColor: 'transparent' }}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
                <p className="text-[11px]" style={{ color: 'var(--text-3)' }}>Click the field to select all, then copy.</p>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={copy}
                  className="btn btn-primary btn-sm flex-1"
                >
                  {copied ? (
                    <span className="flex items-center gap-1.5 justify-center">
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 6l3 3 5-5" />
                      </svg>
                      Copied
                    </span>
                  ) : 'Copy to clipboard'}
                </button>
                <button onClick={handleClose} className="btn btn-ghost btn-sm">Done</button>
              </div>

              <div
                className="flex items-start gap-2 px-3 py-2.5 rounded-[8px]"
                style={{ background: 'color-mix(in srgb, var(--warn) 8%, var(--surface-2))', border: '1px solid color-mix(in srgb, var(--warn) 25%, transparent)' }}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="var(--warn)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: 1, flexShrink: 0 }}>
                  <circle cx="6.5" cy="6.5" r="5.5" />
                  <path d="M6.5 4v3M6.5 9v.5" />
                </svg>
                <span className="text-[11px]" style={{ color: 'var(--warn)' }}>
                  Store offline immediately. Close this window when done.
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

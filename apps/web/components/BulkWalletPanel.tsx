'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { invalidate } from '../lib/useApi';
import { useNetwork } from '../lib/NetworkContext';
import { ChainBadge } from './ui/ChainBadge';

/**
 * Bulk wallet operations — create many, fan out funds, sweep them back.
 *
 * The UX is built around the backend's preview-first contract: every money
 * action renders a plan (per-wallet amounts, fees, blockers) that the user must
 * look at before a confirm button appears. There is no path from a text input
 * straight to a transfer, which matters because these are irreversible and hit
 * every selected wallet at once.
 */

type Mode = 'create' | 'fund' | 'collect';

interface WalletLite {
  id: string;
  chain: 'SOLANA' | 'EVM';
  address: string;
  label?: string;
  isPrimary?: boolean;
}

interface PlanRow {
  walletId: string;
  address: string;
  label: string | null;
  amount: number;
  balanceBefore: number;
  estimatedFee: number;
  usdValue: number;
  blocked?: string;
}

interface Plan {
  op: 'distribute' | 'collect';
  chain: string;
  chainName: string;
  nativeSymbol: string;
  from?: { walletId: string; address: string; balance: number };
  to?: { walletId: string; address: string };
  rows: PlanRow[];
  totalAmount: number;
  totalFees: number;
  totalUsd: number;
  actionable: number;
  blocked: number;
  fatal?: string;
}

interface ResultRow {
  walletId: string;
  address: string;
  amount: number;
  status: 'sent' | 'failed' | 'skipped';
  txHash?: string;
  explorerUrl?: string;
  error?: string;
}

export interface BulkPrefill {
  op: 'fund' | 'collect';
  walletIds: string[];
  /** Changes on every request so repeat clicks re-apply the same selection. */
  nonce: number;
}

export default function BulkWalletPanel({
  wallets,
  prefill,
}: {
  wallets: WalletLite[];
  prefill?: BulkPrefill | null;
}) {
  const { network, isAll, selected } = useNetwork();
  const [mode, setMode] = useState<Mode>('create');

  // A group's Fund/Collect button jumps straight here with that group targeted,
  // so the common path (fund this whole set) is two clicks, not a manual
  // re-selection of wallets the user already grouped.
  useEffect(() => {
    if (!prefill) return;
    setMode(prefill.op === 'fund' ? 'fund' : 'collect');
  }, [prefill?.nonce, prefill?.op]);

  // The chooser drives which chain bulk ops run on. On "all" we cannot pick a
  // network for the user — moving funds on the wrong chain is unrecoverable —
  // so we ask them to scope first rather than guessing.
  const chainKey = isAll ? null : network;
  const family: 'SOLANA' | 'EVM' | null =
    chainKey === 'solana' ? 'SOLANA' : chainKey ? 'EVM' : null;

  const eligible = useMemo(
    () => (family ? wallets.filter((w) => w.chain === family) : []),
    [wallets, family],
  );

  return (
    <section className="section">
      <header className="section-header">
        <h3 className="section-title">Bulk operations</h3>
        <div className="section-actions flex items-center gap-2">
          {chainKey ? (
            <ChainBadge chain={chainKey} />
          ) : (
            <span className="text-xs" style={{ color: 'var(--warn)' }}>
              pick a network
            </span>
          )}
        </div>
      </header>

      <div className="section-body">
        <div className="flex items-center gap-1 mb-4">
          {(['create', 'fund', 'collect'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-ghost'}`}
            >
              {m === 'create' ? 'Create' : m === 'fund' ? 'Fund' : 'Collect'}
            </button>
          ))}
        </div>

        {!chainKey ? (
          <ScopePrompt />
        ) : mode === 'create' ? (
          <CreatePanel family={family!} chainName={selected?.name ?? chainKey} />
        ) : mode === 'fund' ? (
          <TransferPanel op="distribute" chainKey={chainKey} wallets={eligible} prefill={prefill} />
        ) : (
          <TransferPanel op="collect" chainKey={chainKey} wallets={eligible} prefill={prefill} />
        )}
      </div>
    </section>
  );
}

function ScopePrompt() {
  return (
    <div
      className="text-body"
      style={{
        padding: '18px 14px',
        borderRadius: 10,
        border: '1px dashed var(--border-2)',
        color: 'var(--text-2)',
      }}
    >
      Choose a specific network in the top bar first.
      <div className="text-xs mt-1.5" style={{ color: 'var(--text-3)' }}>
        Bulk transfers move real funds on one chain. With “All Networks” selected there is no
        safe default to pick for you.
      </div>
    </div>
  );
}

/* ── Create ─────────────────────────────────────────────────────────────── */

function CreatePanel({ family, chainName }: { family: 'SOLANA' | 'EVM'; chainName: string }) {
  const [count, setCount] = useState(5);
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post('/wallets/bulk/create', {
        chain: family,
        count,
        ...(prefix ? { labelPrefix: prefix } : {}),
      });
      setResult(data);
      invalidate('/wallets');
      invalidate('/wallets/balances');
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1">
          <span className="stat-label">How many</span>
          <input
            className="input"
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
            style={{ width: 96 }}
          />
        </label>
        <label className="flex flex-col gap-1 flex-1" style={{ minWidth: 180 }}>
          <span className="stat-label">Label prefix (optional)</span>
          <input
            className="input"
            placeholder="Sniper"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
          />
        </label>
        <button className="btn btn-primary" onClick={run} disabled={busy}>
          {busy ? 'Creating…' : `Create ${count}`}
        </button>
      </div>

      <p className="text-xs mt-2" style={{ color: 'var(--text-3)' }}>
        {family === 'SOLANA'
          ? 'Solana wallets.'
          : `EVM wallets — the same address works on ${chainName} and every other EVM chain.`}
      </p>

      {error && <Alert kind="bad">{error}</Alert>}

      {result && (
        <div className="mt-4">
          <Alert kind="warn">
            <strong>Back these up now.</strong> Private keys are shown once and never stored in
            plaintext. Export them before leaving this page.
          </Alert>
          <div className="text-sm mt-2" style={{ color: 'var(--text-2)' }}>
            Created {result.created?.length ?? 0} of {result.requested}
            {result.failed?.length ? ` · ${result.failed.length} failed` : ''}
          </div>
          <div className="mt-2" style={{ maxHeight: 220, overflowY: 'auto' }}>
            {(result.created ?? []).map((w: any) => (
              <div
                key={w.id}
                className="font-mono text-[11px] flex items-center justify-between gap-3 py-1"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <span style={{ color: 'var(--text-2)' }}>{w.label}</span>
                <span style={{ color: 'var(--text-3)' }}>
                  {w.address.slice(0, 8)}…{w.address.slice(-6)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Fund / Collect ─────────────────────────────────────────────────────── */

function TransferPanel({
  op,
  chainKey,
  wallets,
  prefill,
}: {
  op: 'distribute' | 'collect';
  chainKey: string;
  wallets: WalletLite[];
  prefill?: BulkPrefill | null;
}) {
  const isFund = op === 'distribute';
  const [anchorId, setAnchorId] = useState<string>(wallets[0]?.id ?? '');
  const [amount, setAmount] = useState(0.01);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [results, setResults] = useState<ResultRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Apply a group's selection, minus the anchor — a wallet cannot fund itself.
  useEffect(() => {
    if (!prefill) return;
    const wanted = new Set(prefill.walletIds);
    setSelectedIds(wallets.filter((w) => wanted.has(w.id) && w.id !== anchorId).map((w) => w.id));
    setPlan(null);
    setResults(null);
    setError(null);
  }, [prefill?.nonce]);

  const counterparties = wallets.filter((w) => w.id !== anchorId);
  const targets = selectedIds.length ? selectedIds : counterparties.map((w) => w.id);

  function reset() {
    setPlan(null);
    setResults(null);
    setError(null);
  }

  async function buildPlan() {
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const body = isFund
        ? { fromWalletId: anchorId, toWalletIds: targets, amountPerWallet: amount, chainKey }
        : { toWalletId: anchorId, fromWalletIds: targets, chainKey };
      const { data } = await api.post(`/wallets/bulk/${op}/plan`, body);
      setPlan(data);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? 'Could not build plan');
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const body = isFund
        ? {
            fromWalletId: anchorId,
            toWalletIds: targets,
            amountPerWallet: amount,
            chainKey,
            confirm: true,
          }
        : { toWalletId: anchorId, fromWalletIds: targets, chainKey, confirm: true };
      const { data } = await api.post(`/wallets/bulk/${op}`, body);
      setResults(data.results ?? []);
      invalidate('/wallets/balances');
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? 'Transfer failed');
    } finally {
      setBusy(false);
    }
  }

  if (wallets.length < 2) {
    return (
      <Alert kind="warn">
        You need at least two wallets on this chain to {isFund ? 'fund' : 'collect'}. Create some
        first.
      </Alert>
    );
  }

  return (
    <div>
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1 flex-1" style={{ minWidth: 220 }}>
          <span className="stat-label">{isFund ? 'Fund from' : 'Collect into'}</span>
          <select
            className="select"
            value={anchorId}
            onChange={(e) => {
              setAnchorId(e.target.value);
              setSelectedIds([]);
              reset();
            }}
          >
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label || 'Wallet'} · {w.address.slice(0, 6)}…{w.address.slice(-4)}
                {w.isPrimary ? ' (primary)' : ''}
              </option>
            ))}
          </select>
        </label>

        {isFund && (
          <label className="flex flex-col gap-1">
            <span className="stat-label">Amount each</span>
            <input
              className="input"
              type="number"
              step="0.001"
              min={0}
              value={amount}
              onChange={(e) => {
                setAmount(Number(e.target.value) || 0);
                reset();
              }}
              style={{ width: 120 }}
            />
          </label>
        )}

        <button className="btn btn-ghost" onClick={buildPlan} disabled={busy || !anchorId}>
          {busy && !plan ? 'Checking…' : 'Preview'}
        </button>
      </div>

      <p className="text-xs mt-2" style={{ color: 'var(--text-3)' }}>
        {selectedIds.length
          ? `${selectedIds.length} wallet${selectedIds.length === 1 ? '' : 's'} selected`
          : `All ${counterparties.length} other wallets on this chain`}
        {' · '}
        {isFund
          ? 'nothing moves until you confirm the preview'
          : 'a gas reserve is always left behind so wallets stay usable'}
      </p>

      <WalletPicker
        wallets={counterparties}
        selected={selectedIds}
        onToggle={(id) => {
          setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
          );
          reset();
        }}
      />

      {error && <Alert kind="bad">{error}</Alert>}

      {plan && !results && <PlanView plan={plan} onConfirm={execute} busy={busy} />}
      {results && <ResultsView results={results} />}
    </div>
  );
}

function WalletPicker({
  wallets,
  selected,
  onToggle,
}: {
  wallets: WalletLite[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {wallets.map((w) => {
        const on = selected.includes(w.id);
        return (
          <button
            key={w.id}
            onClick={() => onToggle(w.id)}
            className="chip cursor-pointer"
            style={{
              borderColor: on ? 'var(--accent)' : 'var(--border)',
              color: on ? 'var(--accent)' : 'var(--text-3)',
              background: on ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--surface-2)',
            }}
            title={w.address}
          >
            {w.label || `${w.address.slice(0, 6)}…`}
          </button>
        );
      })}
    </div>
  );
}

function PlanView({ plan, onConfirm, busy }: { plan: Plan; onConfirm: () => void; busy: boolean }) {
  return (
    <div className="mt-4 fade-in">
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 10,
          background: 'var(--surface-2)',
          overflow: 'hidden',
        }}
      >
        <div
          className="flex items-center justify-between flex-wrap gap-2"
          style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <ChainBadge chain={plan.chain} />
            <span className="text-body" style={{ color: 'var(--text-2)' }}>
              {plan.actionable} transfer{plan.actionable === 1 ? '' : 's'}
              {plan.blocked > 0 && (
                <span style={{ color: 'var(--warn)' }}> · {plan.blocked} skipped</span>
              )}
            </span>
          </div>
          <div className="font-mono text-sm" style={{ fontFeatureSettings: "'tnum' 1" }}>
            {plan.totalAmount.toFixed(6)} {plan.nativeSymbol}
            <span style={{ color: 'var(--text-3)' }}> + ~{plan.totalFees.toFixed(6)} fees</span>
            {plan.totalUsd > 0 && (
              <span style={{ color: 'var(--text-3)' }}> · ${plan.totalUsd.toFixed(2)}</span>
            )}
          </div>
        </div>

        <div style={{ maxHeight: 240, overflowY: 'auto' }}>
          {plan.rows.map((r) => (
            <div
              key={r.walletId}
              className="flex items-center justify-between gap-3"
              style={{
                padding: '7px 12px',
                borderBottom: '1px solid var(--border)',
                opacity: r.blocked ? 0.55 : 1,
              }}
            >
              <span className="font-mono text-[11px]" style={{ color: 'var(--text-3)' }}>
                {r.label || `${r.address.slice(0, 8)}…${r.address.slice(-6)}`}
              </span>
              {r.blocked ? (
                <span className="text-[10px]" style={{ color: 'var(--warn)' }}>
                  {r.blocked}
                </span>
              ) : (
                <span
                  className="font-mono text-[11px]"
                  style={{ color: 'var(--text)', fontFeatureSettings: "'tnum' 1" }}
                >
                  {r.amount.toFixed(6)} {plan.nativeSymbol}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {plan.fatal ? (
        <Alert kind="bad">{plan.fatal}</Alert>
      ) : (
        <div className="flex items-center gap-3 mt-3">
          <button className="btn btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? 'Sending…' : `Confirm ${plan.actionable} transfer${plan.actionable === 1 ? '' : 's'}`}
          </button>
          <span className="text-xs" style={{ color: 'var(--text-3)' }}>
            This is irreversible.
          </span>
        </div>
      )}
    </div>
  );
}

function ResultsView({ results }: { results: ResultRow[] }) {
  const sent = results.filter((r) => r.status === 'sent').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  return (
    <div className="mt-4 fade-in">
      <Alert kind={failed === 0 ? 'ok' : 'warn'}>
        {sent} sent{failed > 0 ? ` · ${failed} failed` : ''}
      </Alert>
      <div className="mt-2" style={{ maxHeight: 240, overflowY: 'auto' }}>
        {results.map((r, i) => (
          <div
            key={`${r.walletId}-${i}`}
            className="flex items-center justify-between gap-3 py-1.5"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <span className="font-mono text-[11px]" style={{ color: 'var(--text-3)' }}>
              {r.address.slice(0, 8)}…{r.address.slice(-6)}
            </span>
            {r.status === 'sent' ? (
              <a
                href={r.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[11px]"
                style={{ color: 'var(--ok)' }}
              >
                {r.amount.toFixed(6)} ↗
              </a>
            ) : (
              <span className="text-[10px]" style={{ color: 'var(--bad)' }}>
                {r.error ?? 'failed'}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Alert({ kind, children }: { kind: 'ok' | 'warn' | 'bad'; children: React.ReactNode }) {
  const color = kind === 'ok' ? 'var(--ok)' : kind === 'warn' ? 'var(--warn)' : 'var(--bad)';
  return (
    <div
      className="text-body mt-3"
      style={{
        padding: '9px 12px',
        borderRadius: 8,
        border: `1px solid color-mix(in srgb, ${color} 35%, var(--border))`,
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
        color: 'var(--text-2)',
      }}
    >
      {children}
    </div>
  );
}

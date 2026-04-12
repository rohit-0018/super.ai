'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { Spinner } from './ui/Skeleton';

type OrderType = 'LIMIT' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP' | 'BRACKET' | 'DCA';

interface Wallet {
  id: string;
  chain: 'SOLANA' | 'EVM';
  address: string;
  isPrimary?: boolean;
}

const ORDER_TYPES: { value: OrderType; label: string; blurb: string }[] = [
  { value: 'LIMIT', label: 'Limit', blurb: 'Buy/sell when price reaches your target.' },
  { value: 'STOP_LOSS', label: 'Stop loss', blurb: 'Auto-sell if position drops below threshold.' },
  { value: 'TAKE_PROFIT', label: 'Take profit', blurb: 'Auto-sell when target profit is reached.' },
  { value: 'TRAILING_STOP', label: 'Trailing stop', blurb: 'Stop loss that follows price up.' },
  { value: 'BRACKET', label: 'Bracket', blurb: 'Entry + take profit + stop loss in one.' },
  { value: 'DCA', label: 'DCA', blurb: 'Dollar-cost average on a recurring schedule.' },
];

export default function AdvancedOrderBuilder({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<OrderType>('LIMIT');
  const { data: wallets = [] } = useApi<Wallet[]>('/wallets');
  const [walletId, setWalletId] = useState('');
  const [tokenIn, setTokenIn] = useState('');
  const [tokenOut, setTokenOut] = useState('');
  const [amount, setAmount] = useState('');
  const [triggerPrice, setTriggerPrice] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [trailingPct, setTrailingPct] = useState('');
  const [dcaInterval, setDcaInterval] = useState('1h');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (wallets.length && !walletId) {
      setWalletId(wallets.find((w) => w.isPrimary)?.id ?? wallets[0].id);
    }
  }, [wallets, walletId]);

  async function submit() {
    if (!walletId || !tokenIn || !tokenOut || !amount) {
      setError('Wallet, tokens, and amount are required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const wallet = wallets.find((w) => w.id === walletId);
      await api.post('/orders', {
        walletId,
        type,
        chain: wallet?.chain ?? 'SOLANA',
        tokenIn,
        tokenOut,
        params: {
          amountIn: parseFloat(amount),
          triggerPrice: triggerPrice ? parseFloat(triggerPrice) : undefined,
          takeProfit: takeProfit ? parseFloat(takeProfit) : undefined,
          stopLoss: stopLoss ? parseFloat(stopLoss) : undefined,
          trailingPct: trailingPct ? parseFloat(trailingPct) : undefined,
          interval: type === 'DCA' ? dcaInterval : undefined,
        },
      });
      setSuccess(`${type} order placed`);
      setTimeout(onClose, 1200);
    } catch (e: any) {
      setError(e?.message ?? 'Order failed');
    } finally {
      setBusy(false);
    }
  }

  const selected = ORDER_TYPES.find((t) => t.value === type)!;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 fade-in"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="glass-strong w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[color:var(--border)]">
          <div>
            <div className="text-[15px] font-semibold">Advanced order</div>
            <div className="text-[12px] text-[color:var(--text-3)]">{selected.blurb}</div>
          </div>
          <button onClick={onClose} className="btn btn-ghost btn-sm">Cancel</button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Type selector */}
          <div>
            <label className="label">Order type</label>
            <div className="grid grid-cols-3 gap-2">
              {ORDER_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setType(t.value)}
                  className="btn btn-sm"
                  style={
                    type === t.value
                      ? { background: 'var(--accent)', color: 'var(--accent-fg)', borderColor: 'var(--accent)' }
                      : undefined
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Wallet */}
          <div>
            <label className="label">Wallet</label>
            <select
              value={walletId}
              onChange={(e) => setWalletId(e.target.value)}
              className="input"
            >
              <option value="">Select wallet…</option>
              {wallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.chain} · {w.address.slice(0, 6)}…{w.address.slice(-4)}
                  {w.isPrimary ? ' (primary)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Token pair */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Token in</label>
              <input
                value={tokenIn}
                onChange={(e) => setTokenIn(e.target.value)}
                placeholder="USDC"
                className="input font-mono"
              />
            </div>
            <div>
              <label className="label">Token out</label>
              <input
                value={tokenOut}
                onChange={(e) => setTokenOut(e.target.value)}
                placeholder="SOL"
                className="input font-mono"
              />
            </div>
          </div>

          <div>
            <label className="label">Amount in</label>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="100"
              inputMode="decimal"
              className="input font-mono"
            />
          </div>

          {/* Type-specific fields */}
          {(type === 'LIMIT' || type === 'STOP_LOSS' || type === 'TAKE_PROFIT') && (
            <div>
              <label className="label">
                {type === 'LIMIT' ? 'Limit price' : type === 'STOP_LOSS' ? 'Stop price' : 'Take-profit price'}
              </label>
              <input
                value={triggerPrice}
                onChange={(e) => setTriggerPrice(e.target.value)}
                placeholder="140.00"
                inputMode="decimal"
                className="input font-mono"
              />
            </div>
          )}

          {type === 'TRAILING_STOP' && (
            <div>
              <label className="label">Trailing %</label>
              <input
                value={trailingPct}
                onChange={(e) => setTrailingPct(e.target.value)}
                placeholder="5"
                inputMode="decimal"
                className="input font-mono"
              />
            </div>
          )}

          {type === 'BRACKET' && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Entry</label>
                <input value={triggerPrice} onChange={(e) => setTriggerPrice(e.target.value)} placeholder="140" className="input font-mono" />
              </div>
              <div>
                <label className="label">Take profit</label>
                <input value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} placeholder="160" className="input font-mono" />
              </div>
              <div>
                <label className="label">Stop loss</label>
                <input value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} placeholder="130" className="input font-mono" />
              </div>
            </div>
          )}

          {type === 'DCA' && (
            <div>
              <label className="label">Schedule</label>
              <select value={dcaInterval} onChange={(e) => setDcaInterval(e.target.value)} className="input">
                <option value="1h">Every hour</option>
                <option value="6h">Every 6 hours</option>
                <option value="1d">Daily</option>
                <option value="1w">Weekly</option>
              </select>
            </div>
          )}

          {error && (
            <div
              className="px-3 py-2 rounded-md text-[12px]"
              style={{ background: 'color-mix(in srgb, var(--bad) 10%, transparent)', color: 'var(--bad)', border: '1px solid color-mix(in srgb, var(--bad) 30%, transparent)' }}
            >
              {error}
            </div>
          )}
          {success && (
            <div
              className="px-3 py-2 rounded-md text-[12px]"
              style={{ background: 'color-mix(in srgb, var(--ok) 10%, transparent)', color: 'var(--ok)', border: '1px solid color-mix(in srgb, var(--ok) 30%, transparent)' }}
            >
              {success}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-[color:var(--border)] flex justify-end gap-2">
          <button onClick={onClose} className="btn">Cancel</button>
          <button onClick={submit} disabled={busy} className="btn btn-primary">
            {busy ? <Spinner size={14} /> : `Place ${selected.label}`}
          </button>
        </div>
      </div>
    </div>
  );
}

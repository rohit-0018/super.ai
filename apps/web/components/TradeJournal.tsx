'use client';
import { useApi } from '../lib/useApi';
import { Skeleton } from './ui/Skeleton';

interface Order {
  id: string;
  createdAt: string;
  type: string;
  chain: string;
  tokenIn: string;
  tokenOut: string;
  status: string;
}

export default function TradeJournal() {
  const { data, loading, error } = useApi<Order[]>('/orders');
  const orders = data ?? [];

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left">
            <Th>Time</Th>
            <Th>Type</Th>
            <Th>Chain</Th>
            <Th>Token in</Th>
            <Th>Token out</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {loading && !data ? (
            Array.from({ length: 4 }).map((_, i) => (
              <tr key={i} className="border-t border-border">
                <td className="py-3 pr-4"><Skeleton w={130} h={12} /></td>
                <td className="py-3 pr-4"><Skeleton w={60} h={20} rounded="md" /></td>
                <td className="py-3 pr-4"><Skeleton w={48} h={12} /></td>
                <td className="py-3 pr-4"><Skeleton w={68} h={12} /></td>
                <td className="py-3 pr-4"><Skeleton w={68} h={12} /></td>
                <td className="py-3 pr-4"><Skeleton w={70} h={20} rounded="md" /></td>
              </tr>
            ))
          ) : error ? (
            <tr>
              <td colSpan={6} className="text-[color:var(--bad)] py-8 text-center text-[13px]">
                {error}
              </td>
            </tr>
          ) : orders.length === 0 ? (
            <tr>
              <td colSpan={6} className="text-[color:var(--text-3)] py-8 text-center text-[13px]">
                No trades yet — ask QWAI to place your first order
              </td>
            </tr>
          ) : (
            orders.map((o) => (
              <tr
                key={o.id}
                className="fade-in border-t border-border hover:bg-[color:var(--surface-hover)] transition-colors"
              >
                <td className="py-3 pr-4 font-mono text-[color:var(--text-2)] whitespace-nowrap">
                  {new Date(o.createdAt).toLocaleString()}
                </td>
                <td className="py-3 pr-4">
                  <span className="chip">{o.type}</span>
                </td>
                <td className="py-3 pr-4 text-[color:var(--text-2)]">{o.chain}</td>
                <td className="py-3 pr-4 font-mono">{o.tokenIn.slice(0, 8)}</td>
                <td className="py-3 pr-4 font-mono">{o.tokenOut.slice(0, 8)}</td>
                <td className="py-3 pr-4">
                  <StatusChip status={o.status} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="stat-label font-medium pb-3 pr-4 whitespace-nowrap">{children}</th>;
}

function StatusChip({ status }: { status: string }) {
  const color =
    status === 'FILLED'
      ? 'var(--ok)'
      : status === 'FAILED'
      ? 'var(--bad)'
      : status === 'PENDING'
      ? 'var(--warn)'
      : 'var(--text-2)';
  return (
    <span className="chip" style={{ color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {status}
    </span>
  );
}

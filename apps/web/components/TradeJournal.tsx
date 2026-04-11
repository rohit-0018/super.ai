'use client';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function TradeJournal() {
  const [orders, setOrders] = useState<any[]>([]);
  useEffect(() => { api.get('/orders').then((r) => setOrders(r.data)).catch(() => setOrders([])); }, []);
  return (
    <div>
      <h3 className="font-bold mb-2">Trade Journal</h3>
      <table className="w-full text-sm">
        <thead className="opacity-60 text-left">
          <tr><th>Time</th><th>Type</th><th>Chain</th><th>Token In</th><th>Token Out</th><th>Status</th></tr>
        </thead>
        <tbody>
          {orders.length === 0 && <tr><td colSpan={6} className="opacity-50 py-2">No trades yet</td></tr>}
          {orders.map((o) => (
            <tr key={o.id} className="border-t border-[#1c2540]">
              <td>{new Date(o.createdAt).toLocaleString()}</td>
              <td>{o.type}</td><td>{o.chain}</td><td>{o.tokenIn.slice(0,8)}</td><td>{o.tokenOut.slice(0,8)}</td><td>{o.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

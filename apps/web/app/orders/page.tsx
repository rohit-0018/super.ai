import OrdersPanel from '../../components/OrdersPanel';

export default function OrdersPage() {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Orders & Activity</h1>
        <p className="text-[13px] text-[color:var(--text-2)] mt-0.5">
          Every trade across web, chat, telegram, agents, DCA, and fast lane.
        </p>
      </header>
      <OrdersPanel />
    </div>
  );
}

export default function Social() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Social</h1>
        <p className="text-[13px] text-[color:var(--text-2)] mt-1">
          Rooms, leaderboards, and copy trading.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="panel">
          <h2 className="section-title mb-3">Trading rooms</h2>
          <p className="text-[13px] text-[color:var(--text-3)]">Coming online with W6.</p>
        </div>
        <div className="panel">
          <h2 className="section-title mb-3">Leaderboard</h2>
          <p className="text-[13px] text-[color:var(--text-3)]">Anonymized PnL rankings.</p>
        </div>
        <div className="panel md:col-span-2">
          <h2 className="section-title mb-3">Copy trading</h2>
          <p className="text-[13px] text-[color:var(--text-3)]">
            Follow top wallets, mirror their trades with your own guardrails.
          </p>
        </div>
      </div>
    </div>
  );
}

import Link from 'next/link';

export default function Landing() {
  return (
    <div className="py-20 max-w-3xl">
      <h1 className="text-[44px] font-semibold tracking-tight leading-[1.05]">
        Your personal AI trading agent.
      </h1>
      <p className="text-[15px] text-[color:var(--text-2)] mt-5 max-w-2xl leading-relaxed">
        QWAI learns your trading style, executes on Solana and EVM 24/7, monitors positions
        while you sleep, and chats naturally on web and Telegram.
      </p>
      <div className="flex gap-3 mt-8">
        <Link href="/login" className="btn btn-primary">
          Connect wallet
        </Link>
        <Link href="/dashboard" className="btn">
          View demo
        </Link>
      </div>
    </div>
  );
}

import Link from 'next/link';

export default function Landing() {
  return (
    <div className="grid gap-8 py-16">
      <h1 className="text-5xl font-bold">Your Personal AI Trading Agent</h1>
      <p className="opacity-80 max-w-2xl">
        QWAI learns your trading style, executes on Solana &amp; EVM 24/7, monitors positions while you sleep, and chats
        naturally on web and Telegram.
      </p>
      <div className="flex gap-4">
        <Link href="/login" className="bg-accent text-black font-bold px-6 py-3 rounded">Connect Wallet</Link>
        <Link href="/dashboard" className="border border-accent px-6 py-3 rounded">View Demo</Link>
      </div>
    </div>
  );
}

'use client';
import Link from 'next/link';

const links = [
  ['/dashboard', 'Dashboard'],
  ['/wallets', 'Wallets'],
  ['/chat', 'Chat'],
  ['/analytics', 'Analytics'],
  ['/social', 'Social'],
  ['/settings', 'Settings'],
];

export default function Navbar() {
  return (
    <nav className="border-b border-[#1c2540] px-6 py-4 flex items-center gap-6">
      <Link href="/" className="font-bold text-xl text-accent">QWAI</Link>
      <div className="flex gap-4 text-sm opacity-80">
        {links.map(([href, label]) => (
          <Link key={href} href={href} className="hover:text-accent">{label}</Link>
        ))}
      </div>
      <div className="ml-auto text-xs opacity-60">v0.1.0</div>
    </nav>
  );
}

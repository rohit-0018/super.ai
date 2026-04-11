'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ThemeToggle from './ThemeToggle';

const links: [string, string][] = [
  ['/dashboard', 'Dashboard'],
  ['/wallets', 'Wallets'],
  ['/chat', 'Chat'],
  ['/analytics', 'Analytics'],
  ['/social', 'Social'],
  ['/settings', 'Settings'],
];

export default function Navbar() {
  const pathname = usePathname();
  return (
    <nav className="sticky top-0 z-40 border-b border-border bg-[color:var(--bg)]">
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center">
        <Link href="/" className="flex items-center gap-2 mr-8">
          <div
            className="w-6 h-6 rounded-md flex items-center justify-center"
            style={{ background: 'var(--text)' }}
          >
            <span
              className="font-bold text-[11px]"
              style={{ color: 'var(--bg)', fontFamily: 'var(--font-mono)' }}
            >
              Q
            </span>
          </div>
          <span className="font-semibold text-[15px] tracking-tight">QWAI</span>
        </Link>
        <div className="flex items-center gap-0.5">
          {links.map(([href, label]) => {
            const active = pathname?.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`px-3 h-8 flex items-center rounded-md text-[13px] font-medium transition-colors ${
                  active
                    ? 'text-text bg-[color:var(--surface-hover)]'
                    : 'text-[color:var(--text-2)] hover:text-text hover:bg-[color:var(--surface-hover)]'
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="chip font-mono">v0.1.0</span>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}

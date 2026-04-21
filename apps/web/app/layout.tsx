import './globals.css';
import type { ReactNode } from 'react';
import { Inter, JetBrains_Mono } from 'next/font/google';
import Navbar from '../components/Navbar';
import AuthGate from '../components/AuthGate';
import ErrorSink from '../components/ErrorSink';

const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata = {
  title: 'QWAI — Your Personal AI Trading Agent',
  description: 'AI trading agent for crypto.',
};

// Prevent theme flash on first paint.
const noFlashScript = `
(function(){try{
  var t = localStorage.getItem('theme');
  if(!t){ t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
  document.documentElement.setAttribute('data-theme', t);
}catch(e){ document.documentElement.setAttribute('data-theme','dark'); }})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body suppressHydrationWarning>
        <ErrorSink />
        {process.env.NEXT_PUBLIC_NETWORK_MODE === 'testnet' && (
          <div
            style={{
              background: 'linear-gradient(90deg, #f59e0b, #d97706)',
              color: '#000',
              textAlign: 'center',
              padding: '6px 16px',
              fontSize: '12px',
              fontWeight: 600,
              letterSpacing: '0.05em',
              position: 'sticky',
              top: 0,
              zIndex: 50,
            }}
          >
            TESTNET MODE — transactions use devnet/Sepolia. Funds are not real.
          </div>
        )}
        <Navbar />
        <main className="max-w-7xl mx-auto px-6 py-8">
          <AuthGate>{children}</AuthGate>
        </main>
      </body>
    </html>
  );
}

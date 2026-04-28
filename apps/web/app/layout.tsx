import './globals.css';
import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import AppShell from '../components/AppShell';
import AuthGate from '../components/AuthGate';
import ErrorSink from '../components/ErrorSink';

const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });
const display = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  title: 'QWAI — AI Trading Agent',
  description:
    'QWAI learns your trading style, executes on Solana and EVM 24/7, monitors positions while you sleep, and chats naturally on web and Telegram.',
  applicationName: 'QWAI',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'QWAI',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
};

export const viewport: Viewport = {
  themeColor: '#0a0d14',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

// Prevent theme flash on first paint.
// qwai is dark-first by design — we ignore prefers-color-scheme and persist 'dark'
// unless the user has explicitly toggled to light via the in-app theme switch.
const noFlashScript = `
(function(){try{
  var t = localStorage.getItem('theme');
  if(t !== 'light' && t !== 'dark'){ t = 'dark'; localStorage.setItem('theme','dark'); }
  document.documentElement.setAttribute('data-theme', t);
}catch(e){ document.documentElement.setAttribute('data-theme','dark'); }})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable} ${display.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
        <script dangerouslySetInnerHTML={{ __html: `
if('serviceWorker' in navigator){
  window.addEventListener('load',function(){
    navigator.serviceWorker.register('/sw.js').catch(function(){});
  });
}` }} />
      </head>
      <body suppressHydrationWarning>
        <ErrorSink />
        {process.env.NEXT_PUBLIC_NETWORK_MODE === 'testnet' && (
          <div
            style={{
              background: 'var(--warn)',
              color: '#0a0d14',
              textAlign: 'center',
              padding: '5px 16px',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              position: 'sticky',
              top: 0,
              zIndex: 60,
            }}
          >
            Testnet mode · devnet / Sepolia · funds are not real
          </div>
        )}
        <AppShell>
          <AuthGate>{children}</AuthGate>
        </AppShell>
      </body>
    </html>
  );
}

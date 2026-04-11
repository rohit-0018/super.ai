import './globals.css';
import type { ReactNode } from 'react';
import Navbar from '../components/Navbar';

export const metadata = { title: 'QWAI — Your Personal AI Trading Agent', description: 'AI trading agent for crypto.' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Navbar />
        <main className="max-w-7xl mx-auto p-6">{children}</main>
      </body>
    </html>
  );
}

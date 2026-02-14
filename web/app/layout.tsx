import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Sidebar } from './components/sidebar';
import './globals.css';

export const metadata: Metadata = {
  title: 'Trade Follower',
  description: 'Trade copy dashboard',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <div className="flex min-h-screen">
          <Suspense>
            <Sidebar />
          </Suspense>
          <main className="flex-1 p-6 overflow-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}

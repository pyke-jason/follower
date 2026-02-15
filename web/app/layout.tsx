import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Suspense } from 'react';
import { AppSidebar } from './components/sidebar';
import { TopBar } from './components/top-bar';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

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
      <body className={`${inter.variable} font-sans antialiased`}>
        <SidebarProvider>
          <Suspense>
            <AppSidebar />
          </Suspense>
          <SidebarInset className="overflow-hidden max-h-svh flex flex-col">
            <Suspense>
              <TopBar />
            </Suspense>
            <div className="flex-1 overflow-auto p-6">{children}</div>
          </SidebarInset>
        </SidebarProvider>
      </body>
    </html>
  );
}

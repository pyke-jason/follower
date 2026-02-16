import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Suspense } from 'react';
import { AppSidebar } from './components/sidebar';
import { TopBar } from './components/top-bar';
import { RunScopeProvider } from './components/run-scope-provider';
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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches);if(d)document.documentElement.classList.add('dark')}catch(e){}})()`,
          }}
        />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <SidebarProvider>
          <Suspense>
            <RunScopeProvider>
              <AppSidebar />
              <SidebarInset className="overflow-hidden max-h-svh flex flex-col">
                <TopBar />
                <div className="flex-1 overflow-auto px-6 pt-6">{children}</div>
              </SidebarInset>
            </RunScopeProvider>
          </Suspense>
        </SidebarProvider>
      </body>
    </html>
  );
}

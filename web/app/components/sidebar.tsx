'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';

const links = [
  { href: '/', label: 'Overview' },
  { href: '/traders', label: 'Traders' },
  { href: '/trades/open', label: 'Open Trades' },
  { href: '/trades', label: 'Trade History' },
  { href: '/messages', label: 'Messages' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/backtests', label: 'Backtests' },
];

export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const runId = searchParams.get('run');

  function buildHref(path: string): string {
    if (!runId) return path;
    return `${path}?run=${runId}`;
  }

  return (
    <aside className="w-56 bg-card border-r flex flex-col min-h-screen">
      <div className="p-4 border-b">
        <h1 className="text-lg font-bold text-foreground">Trade Follower</h1>
        <p className="text-xs text-muted-foreground">Dashboard</p>
      </div>
      <nav className="flex-1 p-2 flex flex-col gap-0.5">
        {links.map((link) => {
          const isActive =
            link.href === '/'
              ? pathname === '/'
              : pathname.startsWith(link.href) &&
                (link.href !== '/trades' || pathname === '/trades');

          // Don't propagate ?run= to backtests pages
          const href = link.href === '/backtests' ? link.href : buildHref(link.href);

          return (
            <Button
              key={link.href}
              variant={isActive ? 'secondary' : 'ghost'}
              size="sm"
              className="justify-start"
              asChild
            >
              <Link href={href}>{link.label}</Link>
            </Button>
          );
        })}
      </nav>
    </aside>
  );
}

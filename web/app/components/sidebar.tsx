'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  TrendingUp,
  History,
  MessageSquare,
  ListTodo,
  FlaskConical,
  Settings,
  ShieldAlert,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { isRunScopedPath } from '@/lib/run-scope';
import { useRunStore } from '@/stores/run-store';

const navLinks = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/traders', label: 'Traders', icon: Users },
  { href: '/trades/open', label: 'Open Trades', icon: TrendingUp },
  { href: '/trades', label: 'Trade History', icon: History },
  { href: '/messages', label: 'Messages', icon: MessageSquare },
  { href: '/tasks', label: 'Tasks', icon: ListTodo },
  { href: '/backtests', label: 'Backtests', icon: FlaskConical },
  { href: '/reconciliation', label: 'Reconciliation', icon: ShieldAlert },
];

export function AppSidebar() {
  const pathname = usePathname();
  const runId = useRunStore((s) => s.runId);

  function buildHref(path: string): string {
    if (!runId || !isRunScopedPath(path)) return path;
    return `${path}?run=${runId}`;
  }

  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href) && (href !== '/trades' || pathname === '/trades');
  }

  const linkClass = (href: string, active: boolean) => {
    const base = active ? 'border-l-2 border-sidebar-primary rounded-l-none bg-sidebar-accent/50' : '';
    if (runId && !isRunScopedPath(href)) return `${base} opacity-40`;
    return base;
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href={buildHref('/')}>
                <div
                  className={`flex aspect-square size-8 items-center justify-center rounded-lg text-xs font-bold ${
                    runId
                      ? 'bg-info text-white'
                      : 'bg-sidebar-primary text-sidebar-primary-foreground'
                  }`}
                >
                  TF
                </div>
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-semibold">Trade Follower</span>
                  <span className="text-xs text-sidebar-foreground/60">
                    {runId ? 'Backtest Mode' : 'Dashboard'}
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navLinks.map((link) => {
                const active = isActive(link.href);
                return (
                  <SidebarMenuItem key={link.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      tooltip={link.label}
                      className={linkClass(link.href, active)}
                    >
                      <Link href={buildHref(link.href)}>
                        <link.icon />
                        <span>{link.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={isActive('/settings')}
              tooltip="Settings"
              className={linkClass('/settings', isActive('/settings'))}
            >
              <Link href="/settings">
                <Settings />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

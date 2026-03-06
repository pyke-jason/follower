import { Link } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
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
import { useScopedHref } from '@/hooks/use-scoped-href';
import { useChannelStore } from '@/stores/channel-store';

const navLinks = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/traders', label: 'Traders', icon: Users },
  { href: '/trades', label: 'Trades', icon: History },
  { href: '/messages', label: 'Messages', icon: MessageSquare },
  { href: '/tasks', label: 'Tasks', icon: ListTodo },
  { href: '/backtests', label: 'Backtests', icon: FlaskConical },
  { href: '/reconciliation', label: 'Reconciliation', icon: ShieldAlert },
];

export function AppSidebar() {
  const { pathname } = useLocation();
  const href = useScopedHref();
  const status = useChannelStore((s) => s.status);

  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  }

  const activeClass = (active: boolean) =>
    active ? 'border-l-2 border-sidebar-primary rounded-l-none bg-sidebar-accent/50' : '';

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to={href('/')}>
                <div
                  className={`flex aspect-square size-8 items-center justify-center rounded-lg text-xs font-bold ${
                    status?.channelKind === 'backtest'
                      ? 'bg-info text-white'
                      : 'bg-sidebar-primary text-sidebar-primary-foreground'
                  }`}
                >
                  TF
                </div>
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-semibold">Trade Follower</span>
                  <span className="text-xs text-sidebar-foreground/60">
                    {status?.channelKind === 'backtest' ? 'Backtest Mode' : 'Runtime'}
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
                      className={activeClass(active)}
                    >
                      <Link to={href(link.href)}>
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
              className={activeClass(isActive('/settings'))}
            >
              <Link to={href('/settings')}>
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

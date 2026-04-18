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
  ClipboardCheck,
  Network,
  Database,
  Tags,
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
import { ChannelScopeSelector } from './channel-scope-selector';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { useChannelStore } from '@/stores/channel-store';

const navLinks = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/traders', label: 'Traders', icon: Users },
  { href: '/trades', label: 'Trades', icon: History },
  { href: '/messages', label: 'Messages', icon: MessageSquare },
  { href: '/tasks', label: 'Tasks', icon: ListTodo },
  { href: '/backtests', label: 'Backtests', icon: FlaskConical },
  { href: '/classify', label: 'Classify', icon: Tags },
  { href: '/reconciliation', label: 'Reconciliation', icon: ShieldAlert },
  { href: '/eval/review', label: 'Eval', icon: ClipboardCheck },
  { href: '/architecture', label: 'Architecture', icon: Network },
  { href: '/db', label: 'Database', icon: Database },
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
    active ? 'border-l-2 border-primary rounded-l-none bg-sidebar-accent' : '';

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Trade Follower">
              <Link to={href('/')}>
                <div
                  className={`flex aspect-square size-8 items-center justify-center rounded-md font-mono text-xs font-bold tracking-tighter ${
                    status?.channelKind === 'backtest'
                      ? 'bg-info text-white'
                      : 'bg-primary text-primary-foreground shadow-glow'
                  }`}
                >
                  TF
                </div>
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-semibold">Trade Follower</span>
                  <span className="text-[10px] font-mono uppercase tracking-widest text-sidebar-foreground/50">
                    {status?.channelKind === 'backtest' ? 'Backtest' : 'Runtime'}
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <ChannelScopeSelector />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <nav aria-label="Primary navigation">
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
      </nav>

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

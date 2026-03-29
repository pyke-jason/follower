// Mount this component in the app root (router.tsx) so it is available on every page.
// It is self-contained: manages its own open/close state and global keydown listener.

import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
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
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useScopedHref } from '@/hooks/use-scoped-href';

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/traders', label: 'Traders', icon: Users },
  { href: '/trades', label: 'Trades', icon: History },
  { href: '/messages', label: 'Messages', icon: MessageSquare },
  { href: '/tasks', label: 'Tasks', icon: ListTodo },
  { href: '/backtests', label: 'Backtests', icon: FlaskConical },
  { href: '/reconciliation', label: 'Reconciliation', icon: ShieldAlert },
  { href: '/eval/review', label: 'Eval', icon: ClipboardCheck },
  { href: '/architecture', label: 'Architecture', icon: Network },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const navigate = useNavigate();
  const href = useScopedHref();

  // Reset search text whenever the palette opens
  useEffect(() => {
    if (open) setSearch('');
  }, [open]);

  // Global Cmd+K / Ctrl+K listener
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const select = useCallback(
    (path: string) => {
      navigate(href(path));
      setOpen(false);
    },
    [navigate, href],
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen} showCloseButton={false}>
      <CommandInput
        placeholder="Search pages..."
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Navigation">
          {navItems.map((item) => (
            <CommandItem
              key={item.href}
              value={item.label}
              onSelect={() => select(item.href)}
            >
              <item.icon className="mr-2 size-4" />
              {item.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

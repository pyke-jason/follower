import { Badge as ShadcnBadge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const COLORS: Record<string, string> = {
  Long: 'bg-emerald-900/50 text-emerald-300 border-emerald-700',
  Short: 'bg-red-900/50 text-red-300 border-red-700',
  Exit: 'bg-blue-900/50 text-blue-300 border-blue-700',
  OPEN: 'bg-emerald-900/50 text-emerald-300 border-emerald-700',
  CLOSED: 'bg-zinc-800 text-zinc-300 border-zinc-600',
  PENDING: 'bg-yellow-900/50 text-yellow-300 border-yellow-700',
  IN_PROGRESS: 'bg-blue-900/50 text-blue-300 border-blue-700',
  COMPLETED: 'bg-emerald-900/50 text-emerald-300 border-emerald-700',
  FAILED: 'bg-red-900/50 text-red-300 border-red-700',
  RUNNING: 'bg-blue-900/50 text-blue-300 border-blue-700',
  SKIPPED: 'bg-zinc-800 text-zinc-400 border-zinc-600',
  CANCELLED: 'bg-zinc-800 text-zinc-400 border-zinc-600',
  LONG: 'bg-emerald-900/50 text-emerald-300 border-emerald-700',
  SHORT: 'bg-red-900/50 text-red-300 border-red-700',
};

const DEFAULT = 'bg-zinc-800 text-zinc-300 border-zinc-600';

export function Badge({ label }: { label: string }) {
  return (
    <ShadcnBadge variant="outline" className={cn('rounded', COLORS[label] ?? DEFAULT)}>
      {label}
    </ShadcnBadge>
  );
}

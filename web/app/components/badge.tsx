import { Badge as ShadcnBadge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const COLORS: Record<string, string> = {
  Long: 'bg-emerald-900/50 text-emerald-300',
  Short: 'bg-red-900/50 text-red-300',
  Exit: 'bg-blue-900/50 text-blue-300',
  OPEN: 'bg-emerald-900/50 text-emerald-300',
  CLOSED: 'bg-zinc-800 text-zinc-300',
  PENDING: 'bg-yellow-900/50 text-yellow-300',
  IN_PROGRESS: 'bg-blue-900/50 text-blue-300',
  COMPLETED: 'bg-emerald-900/50 text-emerald-300',
  FAILED: 'bg-red-900/50 text-red-300',
  RUNNING: 'bg-blue-900/50 text-blue-300',
  SKIPPED: 'bg-zinc-800 text-zinc-400',
  CANCELLED: 'bg-zinc-800 text-zinc-400',
  LONG: 'bg-emerald-900/50 text-emerald-300',
  SHORT: 'bg-red-900/50 text-red-300',
  // Reconciliation alert types
  DB_ONLY: 'bg-red-900/50 text-red-300',
  BROKER_ONLY: 'bg-amber-900/50 text-amber-300',
  QUANTITY_MISMATCH: 'bg-orange-900/50 text-orange-300',
  // Resolved states
  RESOLVED: 'bg-emerald-900/50 text-emerald-300',
  UNRESOLVED: 'bg-red-900/50 text-red-300',
  // Trading state
  HALTED: 'bg-red-900/50 text-red-300 animate-pulse',
};

const DEFAULT = 'bg-zinc-800 text-zinc-300';

export function Badge({ label }: { label: string }) {
  return (
    <ShadcnBadge className={cn(COLORS[label] ?? DEFAULT)}>
      {label}
    </ShadcnBadge>
  );
}

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
  // Strategy types
  STOCK: 'bg-zinc-800 text-zinc-300',
  CALL: 'bg-violet-900/50 text-violet-300',
  PUT: 'bg-orange-900/50 text-orange-300',
  CDS: 'bg-cyan-900/50 text-cyan-300',
  PDS: 'bg-pink-900/50 text-pink-300',
  // Action types
  CLOSE: 'bg-blue-900/50 text-blue-300',
  ADD: 'bg-teal-900/50 text-teal-300',
  TRIM: 'bg-amber-900/50 text-amber-300',
  ADJUST: 'bg-purple-900/50 text-purple-300',
  'NOT TRADE': 'bg-zinc-800 text-zinc-500',
  // Decision outcomes
  EXECUTE: 'bg-emerald-900/50 text-emerald-300',
  SKIP: 'bg-zinc-800 text-zinc-400',
  MANUAL_REVIEW: 'bg-yellow-900/50 text-yellow-300',
  PARTIAL: 'bg-amber-900/50 text-amber-300',
  // Execution step names (deterministic pipeline)
  classify: 'bg-blue-900/50 text-blue-300',
  size_position: 'bg-purple-900/50 text-purple-300',
  check_risk: 'bg-yellow-900/50 text-yellow-300',
  get_quote: 'bg-cyan-900/50 text-cyan-300',
  place_order: 'bg-emerald-900/50 text-emerald-300',
  close_position: 'bg-red-900/50 text-red-300',
  detect_strategy: 'bg-violet-900/50 text-violet-300',
};

const DEFAULT = 'bg-zinc-800 text-zinc-300';

export function Badge({ label }: { label: string }) {
  return (
    <ShadcnBadge className={cn(COLORS[label] ?? DEFAULT)}>
      {label}
    </ShadcnBadge>
  );
}

import { Badge as ShadcnBadge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/* ═══════════════════════════════════════════════
   Midnight Circuit badge palette — cool spectrum
   ═══════════════════════════════════════════════ */

// Teal — profit / long / open / success
const TEAL = 'bg-[oklch(0.94_0.05_175)] text-[oklch(0.35_0.10_175)] dark:bg-[oklch(0.18_0.04_175)] dark:text-[oklch(0.75_0.14_175)]';

// Coral — loss / short / close / error
const CORAL = 'bg-[oklch(0.94_0.04_18)] text-[oklch(0.40_0.12_18)] dark:bg-[oklch(0.18_0.04_18)] dark:text-[oklch(0.72_0.16_18)]';

// Cyan — info / in-progress
const CYAN = 'bg-[oklch(0.94_0.04_230)] text-[oklch(0.38_0.10_230)] dark:bg-[oklch(0.18_0.04_230)] dark:text-[oklch(0.72_0.14_230)]';

// Amber — warning / pending
const AMBER = 'bg-[oklch(0.94_0.05_82)] text-[oklch(0.40_0.12_82)] dark:bg-[oklch(0.18_0.04_82)] dark:text-[oklch(0.80_0.14_82)]';

// Violet — purple states
const VIOLET = 'bg-[oklch(0.94_0.04_290)] text-[oklch(0.38_0.10_290)] dark:bg-[oklch(0.18_0.04_290)] dark:text-[oklch(0.72_0.14_290)]';

// Mint — add / teal-green
const MINT = 'bg-[oklch(0.94_0.04_155)] text-[oklch(0.38_0.10_155)] dark:bg-[oklch(0.18_0.04_155)] dark:text-[oklch(0.72_0.12_155)]';

// Pink — spread states
const PINK = 'bg-[oklch(0.94_0.04_350)] text-[oklch(0.40_0.10_350)] dark:bg-[oklch(0.18_0.04_350)] dark:text-[oklch(0.72_0.14_350)]';

// Slate — neutral / closed / stock
const SLATE = 'bg-[oklch(0.94_0.008_265)] text-[oklch(0.42_0.02_265)] dark:bg-[oklch(0.18_0.008_265)] dark:text-[oklch(0.65_0.015_265)]';

// Dim — faded / skip / not-trade
const DIM = 'bg-[oklch(0.95_0.005_265)] text-[oklch(0.50_0.01_265)] dark:bg-[oklch(0.16_0.005_265)] dark:text-[oklch(0.50_0.01_265)]';

const COLORS: Record<string, string> = {
  // Direction
  Long: TEAL,
  Short: CORAL,
  Exit: CYAN,
  LONG: TEAL,
  SHORT: CORAL,

  // Trade status
  OPEN: TEAL,
  CLOSED: SLATE,

  // Task status
  PENDING: AMBER,
  IN_PROGRESS: CYAN,
  COMPLETED: TEAL,
  FAILED: CORAL,
  RUNNING: CYAN,
  PAUSED: AMBER,
  SKIPPED: DIM,
  EXPIRED: DIM,
  CANCELLED: DIM,

  // Reconciliation
  DB_ONLY: CORAL,
  BROKER_ONLY: AMBER,
  QUANTITY_MISMATCH: AMBER,
  RESOLVED: TEAL,
  UNRESOLVED: CORAL,
  HALTED: CORAL + ' animate-pulse',

  // Strategy type
  STOCK: SLATE,
  CALL: VIOLET,
  PUT: PINK,
  CDS: MINT,
  PDS: PINK,

  // Action hints
  CLOSE: CYAN,
  ADD: MINT,
  TRIM: AMBER,
  ADJUST: VIOLET,
  'NOT TRADE': DIM,

  // Agent decisions
  EXECUTE: TEAL,
  SKIP: DIM,
  FAIL: CORAL,
  MANUAL_REVIEW: AMBER,

  // Decision events
  PARSED: CYAN,
  SIGNAL_RESOLVED: VIOLET,
  SIZED: MINT,
  ORDER_PLACED: TEAL,
  ORDER_ADJUSTED: AMBER,
  ORDER_FILLED: TEAL,
  QUOTE_FAILED: CORAL,
  RETRY_LLM: AMBER,
  SETTLED: SLATE,

  // Decision phases
  orchestrator: CYAN,
  pipeline: VIOLET,
  order: TEAL,

  // Pipeline steps
  classify: CYAN,
  size_position: VIOLET,
  check_risk: AMBER,
  get_quote: MINT,
  place_stock_order: TEAL,
  place_option_order: TEAL,
  close_position: CORAL,
  detect_strategy: VIOLET,
};

const DEFAULT = SLATE;

export function Badge({ label, className }: { label: string; className?: string }) {
  return (
    <ShadcnBadge className={cn('font-mono text-[10px]', COLORS[label] ?? DEFAULT, className)}>
      {label}
    </ShadcnBadge>
  );
}

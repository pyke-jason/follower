import { Badge as ShadcnBadge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/* ═══════════════════════════════════════════════
   Dusk Basin badge palette — warm earth tones
   ═══════════════════════════════════════════════ */

// Sage / olive green — for positive / long / open / success states
const SAGE = 'bg-[oklch(0.94_0.04_150)] text-[oklch(0.38_0.08_148)] dark:bg-[oklch(0.25_0.04_150)] dark:text-[oklch(0.75_0.12_150)]';

// Terracotta / clay — for negative / short / close / error states
const CLAY = 'bg-[oklch(0.94_0.04_35)] text-[oklch(0.42_0.10_30)] dark:bg-[oklch(0.25_0.04_30)] dark:text-[oklch(0.72_0.14_28)]';

// Dusty blue — for in-progress / info states
const DUSTY_BLUE = 'bg-[oklch(0.94_0.03_250)] text-[oklch(0.42_0.08_248)] dark:bg-[oklch(0.25_0.03_250)] dark:text-[oklch(0.70_0.12_250)]';

// Deep amber — for warning / pending states
const AMBER = 'bg-[oklch(0.94_0.05_80)] text-[oklch(0.42_0.10_75)] dark:bg-[oklch(0.25_0.04_75)] dark:text-[oklch(0.78_0.12_80)]';

// Dusty mauve — for purple / violet states
const MAUVE = 'bg-[oklch(0.94_0.04_330)] text-[oklch(0.42_0.08_328)] dark:bg-[oklch(0.25_0.04_330)] dark:text-[oklch(0.70_0.12_330)]';

// Warm teal — for add / teal states
const WARM_TEAL = 'bg-[oklch(0.94_0.04_180)] text-[oklch(0.40_0.08_178)] dark:bg-[oklch(0.25_0.04_178)] dark:text-[oklch(0.72_0.10_180)]';

// Dusty rose — for pink / spread states
const ROSE = 'bg-[oklch(0.94_0.04_10)] text-[oklch(0.42_0.08_8)] dark:bg-[oklch(0.25_0.04_10)] dark:text-[oklch(0.72_0.12_10)]';

// Warm sand neutral — for closed / stock / skip states
const SAND = 'bg-[oklch(0.94_0.015_75)] text-[oklch(0.45_0.02_65)] dark:bg-[oklch(0.25_0.015_65)] dark:text-[oklch(0.65_0.02_70)]';

// Faded sand — for dimmed / not-trade states
const FADED = 'bg-[oklch(0.94_0.01_75)] text-[oklch(0.55_0.015_65)] dark:bg-[oklch(0.25_0.01_65)] dark:text-[oklch(0.55_0.015_70)]';

const COLORS: Record<string, string> = {
  // Direction
  Long: SAGE,
  Short: CLAY,
  Exit: DUSTY_BLUE,
  LONG: SAGE,
  SHORT: CLAY,

  // Trade status
  OPEN: SAGE,
  CLOSED: SAND,

  // Task status
  PENDING: AMBER,
  IN_PROGRESS: DUSTY_BLUE,
  COMPLETED: SAGE,
  FAILED: CLAY,
  RUNNING: DUSTY_BLUE,
  SKIPPED: FADED,
  CANCELLED: FADED,

  // Reconciliation
  DB_ONLY: CLAY,
  BROKER_ONLY: AMBER,
  QUANTITY_MISMATCH: AMBER,
  RESOLVED: SAGE,
  UNRESOLVED: CLAY,
  HALTED: CLAY + ' animate-pulse',

  // Strategy type
  STOCK: SAND,
  CALL: MAUVE,
  PUT: ROSE,
  CDS: WARM_TEAL,
  PDS: ROSE,

  // Action hints
  CLOSE: DUSTY_BLUE,
  ADD: WARM_TEAL,
  TRIM: AMBER,
  ADJUST: MAUVE,
  'NOT TRADE': FADED,

  // Agent decisions
  EXECUTE: SAGE,
  SKIP: FADED,
  MANUAL_REVIEW: AMBER,

  // Pipeline steps
  classify: DUSTY_BLUE,
  size_position: MAUVE,
  check_risk: AMBER,
  get_quote: WARM_TEAL,
  place_stock_order: SAGE,
  place_option_order: SAGE,
  close_position: CLAY,
  detect_strategy: MAUVE,
};

const DEFAULT = SAND;

export function Badge({ label }: { label: string }) {
  return (
    <ShadcnBadge className={cn(COLORS[label] ?? DEFAULT)}>
      {label}
    </ShadcnBadge>
  );
}

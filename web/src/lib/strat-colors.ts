import type { Strategy } from '@src/lib/enums';

/**
 * CSS variable strings for each strategy. Use as Recharts `stroke` / `fill`
 * props or anywhere a string color value is required. For Tailwind class-based
 * usage prefer `bg-strategy-{key}` etc. (see `web/src/globals.css`).
 *
 * Tokens are defined in `web/src/globals.css` and respect light/dark mode.
 */
export const STRAT_COLOR: Record<Strategy, string> = {
  CDS: 'var(--color-strategy-cds)',
  PDS: 'var(--color-strategy-pds)',
  CALL: 'var(--color-strategy-call)',
  PUT: 'var(--color-strategy-put)',
  STOCK: 'var(--color-strategy-stock)',
  CCS: 'var(--color-strategy-ccs)',
  PCS: 'var(--color-strategy-pcs)',
};

/** Stable rendering order — matches the design's stacked-area layering. */
export const STRAT_ORDER: Strategy[] = ['STOCK', 'CDS', 'PDS', 'PUT', 'CALL', 'CCS', 'PCS'];

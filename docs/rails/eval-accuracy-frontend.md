# Eval Accuracy — Frontend Integration

Classification accuracy integrates directly into the trades table. Any trade has a source message, any message can have a label. This is not backtest-specific.

## Signal comparison model

One Signal = one trade. Diff the whole thing, return what's different.

```ts
type MatchResult = {
  mismatches: Mismatch[];  // empty = perfect match
};

type Mismatch = {
  path: string;       // "action", "strategy", "legs[1].expiry"
  expected: string;
  got: string;
};
```

Works for any structure — top-level fields, leg fields, any depth. A calendar with wrong expiry on the second leg: `{ path: "legs[1].expiry", expected: "June", got: "July" }`.

## Trade label data

```ts
// On any trade — not backtest-specific
type TradeLabel = {
  bucket: 'tp' | 'fp' | 'unlabeled';
  match: MatchResult | null;         // null for fp/unlabeled
  labelSignals: Signal[] | null;     // ground truth for display
};
```

Attached to the trade via `sourceMessageId` → `eval_labels.messageId`. Works for backtest trades, live trades, any trade.

## API: Enrich existing responses

Any endpoint that returns trades can LEFT JOIN `eval_labels` on `sourceMessageId` and attach `TradeLabel`. No separate endpoint.

For the backtest detail page, also compute an aggregate summary:

```ts
evalSummary: {
  labeled: number;
  unlabeled: number;
  confusion: { tp: number; fp: number; tn: number; fn: number };
  metrics: { accuracy: number; precision: number; recall: number; f1: number };
  // Mismatch frequency across all TPs, grouped by path
  // e.g. { "strategy": 12, "legs[0].strike": 3, "action": 1 }
  mismatchCounts: Record<string, number> | null;
  totalMismatches: number;
} | null;  // null when zero labels exist
```

Computed server-side from the joined rows. No extra query.

## Trades table integration

### Per-trade Label column

New column in `TradesTableClient`: **"Label"** (compact, icon-only)

| Row state | Icon | Tooltip |
|---|---|---|
| `tp`, 0 mismatches | Green check | "Label match" |
| `tp`, has mismatches | Green check + orange dot | "Trade matched, N field diffs" |
| `fp` | Red X | "Label says not a trade" |
| `unlabeled` | Yellow warning triangle | "No label" |

**Expandable row detail:** For TPs with mismatches, the existing expandable row gains a label diff section listing the `mismatches[]` array — each entry shows path, expected, got. Simple list, red text for the `got` value.

### Cumulative accuracy strip

Above the trades table, `MetricStrip` row from `evalSummary`:

```
Labels: 342/400 (85%)  |  Accuracy: 91%  |  Precision: 94%  |  Recall: 88%  |  F1: 0.91  |  ⚠ 58 unlabeled
```

- `⚠ N unlabeled` is amber badge. Red when unlabeled > 20%.
- If `evalSummary` is null: "No labels for this date range" in muted text. No metric strip. No Label column.

### Messages without labels

1. **Per-row:** Yellow warning triangle in Label column. Native `title` (virtualized table): "No label — accuracy unknown."
2. **Cumulative:** `unlabeled` count in metric strip, always visible.

## File changes

| File | Change |
|------|--------|
| `src/local-api/routes/web-queries.ts` | Trade queries: LEFT JOIN eval_labels, compute TradeLabel per row |
| `web/src/views/backtests/[id]/page.tsx` | Pass evalSummary to metric strip |
| `web/src/components/trades-table-client.tsx` | Add Label column reading `trade.label` |
| `web/src/components/filtered-trades-view.tsx` | Thread evalSummary for metric strip |

No new files. No new endpoints. No new frontend queries.

<project_overview>
  You are an expert AI assistant working on "Trade Follower 3".
  Stack: Monorepo with Node.js backend (src/), Next.js frontend (web/), SQLite via Drizzle ORM.
  Schema: `src/db/schema.ts`. Web imports from `src/` use relative paths.
</project_overview>

<architecture_and_flow>
  <signal_flow>
    Chat message → intent extraction (LLM) → Signal → trade agent (skip/execute) → pipeline → broker → record trade.
    Key pipeline: `extract-intent.ts` → `trade-agent.ts` → `execute.ts` → `record-trade.ts`.
  </signal_flow>

  <backtest_vs_live>
    Both paths use the same `PipelineDeps` interface (`src/pipeline/execute.ts`) but with different implementations.
    - Broker: `SimBroker` (backtest) vs `TradeStation liveService` (live).
    - Positions: `broker.getOpenTrades` (backtest) vs direct DB query (live).
    - Risk Limits: No-op in backtest vs full check in live.
    - ALWAYS IDENTICAL: `recordTrade()`, `executeSignals()`, `computeTradePnl()`, `buildPositionSizer()`, and `filters.ts`. If adding a feature to one path, verify if the other needs it.
  </backtest_vs_live>

  <data_model>
    - `trades` table is a denormalized view.
    - `trade_events` table is the append-only source of truth.
    - `recordTrade()` is the SINGLE write path for all mutations. Pass `tradeId` if known to skip redundant queries.
    - `computeCoreStats()` is the SINGLE source of truth for trade stats.
  </data_model>
</architecture_and_flow>

<directory_structure>
  - `src/lib/`: ALL shared utilities (numbers, dates, PnL, enums). Never duplicate code; import from here.
  - `src/position-sizing/`: Factory `buildPositionSizer()` (Discriminated union on strategy).
  - `src/trades/filters.ts`: Composable Drizzle query fragments (imports from `db/schema`, not `db/client` for web compatibility).
</directory_structure>

<coding_standards>
  - STRICT BOUNDARY VALIDATION: Validate cross-field constraints via Zod `.refine()` at entry points (e.g., limits require `limitPrice`). Do not use ad-hoc throws deep in business logic.
  - NARROWED CALLBACK TYPES: If a callback fires in a narrowed state, type it narrowed (e.g., `onFill` gets `FilledWorkingOrder`, not `WorkingOrder`). No `!` assertions.
  - NO BACKWARDS COMPATIBILITY: No optional fields for old runs, no shims, no deprecated exports. If a type changes, update all consumers. Internal tool only.
  - CLEAN AS YOU GO: Fix dead exports, duplicate logic, and leaky abstractions in the files you are already touching. Do not go on refactor safaris outside current files.
  - DRY / ONE CONCEPT, ONE PLACE: If two modules do the same thing, delete one. Do not abstract ahead of need.
  - NO INLINE TYPE IMPORTS: Always use top-level `import type { Type } from 'path'`.
  - DRIZZLE JSON COLUMNS: `$type<>()` does NOT propagate through `select()`. Create a typed accessor per JSON column (e.g., `getLegs(row): TradeLeg[]`) in `db/accessors.ts`. Cast/parse happens ONCE inside the accessor; call sites never cast.
  - NO INDEX SIGNATURES ON TYPED INTERFACES: `[key: string]: unknown` destroys typed access. For action-varying metadata, use a discriminated union. Unknown extras go in an explicit `extra?: Record<string, unknown>` field.
  - DERIVE, DON'T DUPLICATE TYPES: Downstream types use `Pick`, `Omit`, `Extract`, or Zod `.infer` from the canonical type. If two types share 80%+ fields, one derives from the other. Inline anonymous object types are banned in cross-module signatures — name them.
  - TWO CASTS = HELPER, THREE = BUG: If the same `as X` cast appears twice, extract an accessor. Three times means the type should flow correctly from the source. `as any` requires `// SAFETY:` comment. Prefer Zod `.parse()` over `as` at CLI/env boundaries.
  - FIELD NAME CONSISTENCY: Same concept (e.g., BUY/SELL on a leg) uses the same field name everywhere. If DB says `action` and orchestrator says `side`, pick one or make the adapter the SINGLE named conversion point.
  - ONE LOG LINE PER EVENT: When multiple layers handle the same event (e.g., broker fill → order manager → record-trade), only the authoritative layer logs at info level. Others use debug or stay silent. The authoritative layer is the one that owns the state change.
  - WARN MEANS ACTIONABLE: `log.warn` is reserved for conditions a human should investigate. Expected behavior (dedup hits, API 206 responses, timing metrics) belongs at info or debug.
</coding_standards>

<domain_rules>
  - DATABENTO COSTS MONEY: They charge per byte. Fetch minimum columns, narrowest date ranges, prefer cache. Never mass-delete `.cache/databento/` files. Empty `[]` files are valid.
  - TIMESTAMP STRICTNESS: Backtest trades MUST have explicit timestamps. Never fall back to wall-clock time.
  - DYNAMIC TIMEZONES: `dayBoundsUTC()` dynamically detects EST/EDT. Never hardcode UTC offsets.
  - DIRECTION SEMANTICS: The `direction` field (LONG/SHORT) means whether the trader is BUYING or SELLING the instrument. It does NOT represent their bullish/bearish stock view. Key mappings:
    - "Short [ticker] puts/calls" = bearish/bullish VIEW, but BUYING options → direction: LONG.
    - "Sold [ticker] puts" = SELLING puts for premium (bullish) → direction: SHORT. "Sold" is authoritative.
    - "Long [ticker] pcs 68/67 for credit" = bullish VIEW, SELLING a put credit spread → direction: SHORT, strategy: PDS.
    - Debit strategies (CDS, PDS bought, naked long options) = always direction: LONG.
    - Credit strategies (PCS, sold/written options) = always direction: SHORT.
    - "Lotto"/"Yolo" = speculative BUY, always direction: LONG, never sell-to-open.
    - "Bought"/"Sold" in the message are authoritative — they override any Long/Short prefix badge.
  - NEVER USE MARKET ORDERS ON OPTIONS: Options have massive bid-ask spreads (often $1-3+). MARKET orders fill at the worst side of the spread, costing $0.50+/contract — on a 12-contract position that's $600+ of avoidable slippage. ALWAYS use LIMIT orders with price-chase logic for options. This applies to ALL order types: OPEN, CLOSE, TRIM, LEG_OFF. The chase mechanism (`OrderManager` + `PRICE_CHASE` adjustment rules) widens the limit incrementally until filled. Position-reducing orders (CLOSE/TRIM/LEG_OFF) use `CLOSE_ORDER_DEFAULTS` with wider chase steps, no `cancelAfterSec`, and `maxSteps` caps — they persist until filled or day boundary. NEVER propose MARKET as a "simpler" alternative.
</domain_rules>

<workflows>
  <debugging>
    Use disposable scripts in `scripts/` to isolate suspects with REAL data, configs, and DB records. DO NOT USE MOCKS. Run via `npx tsx scripts/debug-xxx.ts`. Delete script when verified. Do not read `.env` directly; rely on environment variables.
  </debugging>
  
  <self_documentation>
    MANDATORY: Create a lesson file in `docs/lessons/` after every implementation session (new features, bugs, schema changes).
    Format: `YYYY-MM-DD-slug.md`. Plain text, flat, scannable.
    Sections: Problem, Decision, Key Files, Watch Out.
  </self_documentation>
</workflows>
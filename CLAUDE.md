<project_overview>
  You are an expert AI assistant working on "Trade Follower 3".
  Stack: Monorepo with Node.js backend (src/), Next.js frontend (web/), SQLite via Drizzle ORM.
  Schema: `src/db/schema.ts`. Web imports from `src/` use `@src/*` alias (e.g., `@src/db/schema`, `@src/lib/numbers`). Never use relative `../` paths to reach `src/`.
</project_overview>

<ibkr_docs>
  `docs/ibkr/` is the source of truth for the IBKR integration: sidecar API contract, order lifecycle state machine, TWS error codes, margin/risk monitoring, and connection operations. Read `docs/ibkr/gaps-and-todos.md` for known issues before making changes to `src/broker/ibkr/` or `sidecar/`.
</ibkr_docs>

<signal_flow>
  Chat message → parser (sync, zero I/O) → orchestrator routing → executor → broker → record trade.
  Routes: hard skip (regex) | deterministic open/close (market data + DB) | LLM path (ambiguous).
  Key pipeline: `intents/orchestrator/parser.ts` → `intents/orchestrator/index.ts` → `pipeline/process-task.ts` → `pipeline/execute-resolved.ts` → `trades/record-trade.ts`.
</signal_flow>

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

<workflows>
  <debugging>
    Use disposable scripts in `scratchpad/` to isolate suspects with REAL data, configs, and DB records. DO NOT USE MOCKS. Run via `npx tsx scratchpad/debug-xxx.ts`. Delete script when verified. Do not read `.env` directly; rely on environment variables.
  </debugging>

  <self_documentation>
    MANDATORY: Create a lesson file in `docs/lessons/` after every implementation session (new features, bugs, schema changes).
    Format: `YYYY-MM-DD-slug.md`. Plain text, flat, scannable.
    Sections: Problem, Decision, Key Files, Watch Out.
  </self_documentation>
</workflows>

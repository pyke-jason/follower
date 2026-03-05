# Trade Fixes — Agent Team Execution Plan

## Objective

Fix 8 bugs (5 critical, 3 medium) identified in backtest `df8c003c`. Each bug gets a dedicated analysis agent, two auditors synthesize an implementation plan, then implementation agents execute in parallel.

---

## Phase 1: Analysis (Parallel)

8 analysis agents, one per bug. Each writes a markdown doc to `docs/trade-fixes/` with:
- **Root cause** — exact file, function, line, and logic path that produced the bug
- **Evidence** — DB query or parser trace showing the failure
- **Proposed fix** — specific code changes with before/after
- **Files touched** — every file the fix modifies
- **Risk** — what could break, what tests to add
- **Intersections** — which other bugs likely share root cause or touch the same code

### Bug Assignments

| Agent | Bug | Output File |
|-------|-----|------------|
| analyst-1 | BUG-1: OSCR SHORT direction inversion (LLM misroute) | `docs/trade-fixes/bug-1-oscr-direction.md` |
| analyst-2 | BUG-2: Missed TSLA close → duplicate position (multi_ticker skip) | `docs/trade-fixes/bug-2-tsla-close-skip.md` |
| analyst-3 | BUG-3: Spurious MSTR close on "hold" message | `docs/trade-fixes/bug-3-mstr-hold-close.md` |
| analyst-4 | BUG-4: ABNB PUT 0DTE direction + no expiry close | `docs/trade-fixes/bug-4-abnb-direction-expiry.md` |
| analyst-5 | BUG-5: Duplicate NVDA SHORT from near-duplicate messages | `docs/trade-fixes/bug-5-nvda-dedup.md` |
| analyst-6 | ISSUE-1: Options not auto-closed at expiry (systemic) | `docs/trade-fixes/issue-1-expiry-sweep.md` |
| analyst-7 | ISSUE-2: Option sizing uses underlying price not premium | `docs/trade-fixes/issue-2-option-sizing.md` |
| analyst-8 | ISSUE-3: Missed TSLA signal in concatenated message | `docs/trade-fixes/issue-3-concat-signal.md` |

---

## Phase 2: Audit & Synthesis (2 Auditors)

Two auditor agents read all 8 analysis docs and produce:

1. **Intersection map** — which fixes touch the same files/functions and could conflict
2. **Dependency graph** — which fixes must land before others (e.g., expiry sweep before direction fix)
3. **Seam plan** — optimal grouping into parallel implementation batches that avoid merge conflicts
4. **Consensus doc** — `docs/trade-fixes/audit-consensus.md` with final implementation plan

### Expected Seam Groups (hypothesis, auditors confirm)

| Seam | Bugs | Key Files | Rationale |
|------|------|-----------|-----------|
| A: Parser direction rules | BUG-1, BUG-3, BUG-4 | `parser.ts` | All involve direction/action misparse |
| B: Multi-ticker & dedup | BUG-2, BUG-5, ISSUE-3 | `parser.ts`, `orchestrator/index.ts`, `process-task.ts` | Message handling before execution |
| C: Option lifecycle | BUG-4 (expiry part), ISSUE-1 | New: `expiry-sweep.ts`, `record-trade.ts` | Expiry close is net-new feature |
| D: Option sizing | ISSUE-2 | `execute-resolved.ts`, `position-sizing/index.ts` | Isolated to sizing path |

---

## Phase 3: Implementation (Parallel by Seam)

One implementation agent per seam group. Each agent:
1. Reads the consensus doc for their seam
2. Implements the changes
3. Runs existing tests + writes new test cases
4. Documents changes in a lesson file

---

## Key Pipeline Files Reference

| File | Role |
|------|------|
| `src/intents/orchestrator/parser.ts` | Sync parser — direction, action, strategy, field extraction |
| `src/intents/orchestrator/index.ts` | Orchestrator routing — deterministic vs LLM |
| `src/intents/orchestrator/llm-path.ts` | LLM agent for ambiguous messages |
| `src/intents/orchestrator/open-path.ts` | Resolves OPEN/ADD signals (expiry, strikes, legs) |
| `src/intents/orchestrator/position-path.ts` | Resolves CLOSE/TRIM/LEG_OFF signals |
| `src/pipeline/process-task.ts` | Task queue → orchestrator bridge |
| `src/pipeline/execute-resolved.ts` | Signal → broker order execution |
| `src/trades/record-trade.ts` | Only write path for trades table |
| `src/position-sizing/index.ts` | Notional sizing calculator |
| `src/lib/expiry-warning.ts` | Expiry alerts (live mode only) |
| `src/config/risk-defaults.ts` | Default sizing/risk params |

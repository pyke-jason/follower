# Intent Eval System

## Problem
No systematic way to test intent extraction quality. A LEAP trade was silently misfiled because the LLM omitted legs → system defaulted to nextFriday() expiry. No eval caught it.

## Decision
Built a full eval harness with real LLM calls (no mocks), weighted scoring, and JSON fixture files as ground truth.

## Architecture
- `EvalSource` interface: two implementations — `FixtureSource` (JSON files) and `DbSource` (message_labels table)
- `scoreCase()`: pure function. Decision gate → mustMatch hard fails → weighted field scores → pass/fail
- `runner.ts`: calls real LLM using INTENT_SYSTEM_PROMPT + tool stubs for eval mode (stub get_recent_chat returns empty)
- `reporter.ts`: ANSI table by tag, shows failures with hard-fail labels, supports diff against baseline
- CLI: `npx tsx scripts/eval-intents.ts` with --source, --tag, --model, --baseline, --output, --temperature flags

## Key Files
- `src/intents/evals/types.ts` — shared types (EvalCase, EvalSource, EvalResult, EvalRunResult)
- `src/intents/evals/scorer.ts` — pure scoring logic with LEAP expiry detection (≥6 months)
- `src/intents/evals/runner.ts` — real LLM calls, concurrency control, per-case timing. Default temperature=0.
- `src/intents/evals/reporter.ts` — stdout report + diffRuns() for baseline comparison
- `src/intents/evals/sources/fixture.ts` — FixtureSource reads JSON from dir
- `src/intents/evals/sources/db.ts` — DbSource reads reviewed message_labels
- `src/intents/evals/fixtures/` — 42 ground-truth cases across 6 files
- `scripts/eval-intents.ts` — CLI entrypoint

## Fixture Coverage (42 cases)
- `regressions.json` (5): LEAP x2, PCS direction, sold-authoritative, exit with loss context
- `direction.json` (13): direction confusion — Short prefix, Lotto, PCS, sold/wrote
- `exits.json` (8): CLOSE/TRIM/LEG_OFF language recognition
- `spreads.json` (5): spread leg order, PCS vs PDS direction
- `core.json` (5): false positives, commentary, add-ons
- `strangle-overnight.json` (6): strangle parsing, overnight position, badge disambiguation

## LEAP Fix (implemented)
Three-part fix for LEAP trade misfiling:

1. **`normalizeExpiry` (`occ-symbology.ts`)**: Added "LEAP/Leaps/LEAPS" → referenceDate + 1 year.
   The scorer's `compareExpiry("LEAP", actual, refDate)` calls normalizeExpiry on the actual value and checks ≥6 months.
   After the fix, `normalizeExpiry("LEAP", refDate)` returns a valid date ≥6 months → scorer passes.

2. **`resolveSignalLegs` (`execute.ts`)**: When all legs have `strike === 0`, extract expiry hint from that leg instead of defaulting to `nextFriday()`.
   Pattern: model emits `legs: [{ strike: 0, expiry: "LEAP", optionType: "CALL", action: "BUY" }]` and the pipeline honors the LEAP expiry when inferring ATM strikes.

3. **`INTENT_SYSTEM_PROMPT` (`extract-intent.ts`)**: Added to `<slang>`:
   `"Leap"/"Leaps"/"LEAP"/"LEAPS" = long-dated options 1+ year out. Use expiry: "LEAP" and strike: 0 in legs.`
   Added rule: "LEAP expiry exception: always emit a leg with expiry: 'LEAP' and strike: 0 even without stated strikes."
   Added canonical example showing "Added to SPY Leaps" → `legs [BUY 0C expiry=LEAP]`.

## Temperature Support
Added `temperature?: number` to `ChatParams`, `AgentConfig`, `RunEvalOptions`, and the CLI `--temperature` flag.
- Default for evals: 0 (deterministic/reproducible)
- Production: omitted (provider default, typically ~1.0)
- Chain: `eval-intents.ts` → `runner.ts` → `runAgentLoop` → `chatWithTools` → Anthropic/xAI API

## Watch Out
- ExpectedSignal.action includes 'ADD' (to match Signal schema), but the LLM tool schema doesn't expose 'ADD'
- DbSource.targetStrategy narrows Signal's StrategySchema to CALL|PUT (only valid for LEG_OFF)
- Runner stubs get_recent_chat as empty — tests prompt comprehension, not follow-trade resolution
- mustMatch = [] on SKIP cases (decision gate handles it; no signals to check)
- Exit code 1 when any case fails — CI-compatible
- `SignalLegSchema.strike` is required and nonneg — use `strike: 0` as the sentinel for "no strike, expiry hint only"
- grok-fast text-recovery path: model sometimes emits text format `legs [BUY 0C]` without `expiry=LEAP` even with T=0. This is a model quality issue — the `parseLegsText` regex supports `expiry=LEAP` but grok doesn't always include it in text output.
- Calendar/time spread rule: `When both Long+Short badges appear, flag for review` — conflicts with strangles. Strangles also show both badges. Fix: add a strangle exception when "strangle" appears in the message text.

## Open Failures at T=0 (grok-4-1-fast, 33/42 = 79%)
- **lotto x3**: grok-fast returns SHORT for "Short XXX Lotto" — ignores the Lotto override rule
- **LEAP x1**: text-recovery path omits expiry in batch (passes individually)
- **strangle x3**: Long+Short badge rule → MANUAL_REVIEW, but strangles need EXECUTE
- **overnight x1**: "for overnight" — model doesn't infer non-0DTE
- **exit-with-context x1**: "Exit NFLX with .12 loss per contract" — model skips instead of closing

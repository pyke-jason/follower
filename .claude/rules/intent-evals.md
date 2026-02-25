---
paths:
  - "src/intents/evals/**/*"
  - "scripts/eval-orchestrator.ts"
  - "src/intents/orchestrator/**/*"
---

# Orchestrator Eval System

Evaluates the orchestrator (`resolveOrchestrator`) against ground-truth test cases. Used to catch regressions when changing the parser, open-path, position-path, or LLM-path.

## Architecture

- **scorer.ts**: Compares `OrchestratorResult` vs expected output per-field. Produces a 0-1 score. `PASS_THRESHOLD = 0.8`. `mustMatch` fields cause hard fail regardless of score.
- **reporter.ts**: Terminal output with color. `printReport()` for single runs, `diffRuns()` for baseline comparison.
- **types.ts**: `EvalCase`, `EvalResult`, `EvalRunResult`, `EvalSource`, `ExpectedSignal`, `ExpectedLeg`, `EvalInput`.

## Sources

- **FixtureSource** (`sources/fixture.ts`): Reads JSON files from `evals/fixtures/`. Each file has `{ cases: EvalCase[] }`. Deterministic, checked into git.

## Fixture Files

JSON files in `evals/fixtures/` organized by concern:
- `core.json` — basic OPEN/SKIP cases
- `direction.json` — LONG/SHORT semantics (sold puts, credit spreads, lottos)
- `exits.json` — CLOSE/TRIM/LEG_OFF
- `spreads.json` — CDS/PDS with legs
- `strangle-overnight.json` — strangles and overnight positions
- `regressions.json` — specific bugs that were caught and pinned

## Scoring Rules

1. Outcome mismatch (EXECUTE vs SKIP) -> score 0, immediate fail (not a hard fail).
2. Outcome match with no expected signals -> score 1.0, pass.
3. Signal matching: match expected to actual by leg optionType composition, then positional fallback.
4. Fields scored per signal (only if present in expected): `orderType`, `hasTradeId` (checks `tradeId != null`), `exitPercent` (+-0.01 tolerance).
5. Leg fields: `side`, `strike` (+-0.5 tolerance), `optionType`, `expiry` (via `compareExpiry` with LEAP handling).
6. Legs matched by optionType first, then positional fallback.
7. `mustMatch` paths checked independently — any miss = `hardFail: true`, overrides score.

## Running Evals

```bash
npx tsx scripts/eval-orchestrator.ts                          # all fixtures
npx tsx scripts/eval-orchestrator.ts --tag skip               # filter by tag (skip cases need no LLM)
npx tsx scripts/eval-orchestrator.ts --case core-001          # single case
npx tsx scripts/eval-orchestrator.ts --provider xai --model grok-3  # different model
```

## Adding Test Cases

1. Pick the right fixture file by concern (or create a new one for a new category).
2. Each case needs: `id` (unique, prefix with filename slug), `description`, `input.message`, `expected.outcome`, `expected.signals` (if EXECUTE).
3. Expected signals use `ExpectedSignal` shape: `orderType`, `hasTradeId`, `exitPercent`, `legs[]` with `side`, `strike`, `optionType`, `expiry`.
4. Add `mustMatch` for fields that are critical (e.g. `signals[0].legs[0].side`, `signals[0].orderType`).
5. Add `tags` for filtering — at minimum the fixture filename slug.
6. For exit cases that need position matching, add `positions` array to `input`.
7. Run the eval to verify the case passes before committing.

## Watch Out

- The eval calls `resolveOrchestrator()` directly — changes to the parser, open-path, position-path, or LLM-path affect results.
- Skip cases (hard skip in parser) need no LLM provider or market data — fast and free.
- EXECUTE cases that hit the open-path need `DATABENTO_API_KEY` for market data.
- LLM-path cases need an LLM provider configured (default: anthropic/claude-sonnet-4-6).
- `positions` in fixture input feeds the `PositionProvider` — required for CLOSE/TRIM/LEG_OFF cases that go through position-path.

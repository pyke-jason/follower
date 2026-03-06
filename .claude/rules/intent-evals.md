---
paths:
  - "src/intents/evals/**/*"
  - "scripts/eval-orchestrator.ts"
  - "src/intents/orchestrator/**/*"
---

# Orchestrator Eval System

Evaluates the orchestrator (`resolveOrchestrator`) against ground-truth test cases. Used to catch regressions when changing the parser, open-path, position-path, or LLM-path.

## Architecture

- **scorer.ts**: Compares `OrchestratorResult` vs expected output per-field. Produces a 0-1 score with configurable pass threshold. `mustMatch` fields cause hard fail regardless of score.
- **reporter.ts**: Terminal output with color. `printReport()` for single runs, `diffRuns()` for baseline comparison.
- **types.ts**: All shared eval types (`EvalCase`, `EvalResult`, `ExpectedSignal`, etc.).

## Sources

- **FixtureSource** (`sources/fixture.ts`): Reads JSON files from `evals/fixtures/`. Each file has `{ cases: EvalCase[] }`. Deterministic, checked into git.

## Fixture Files

JSON files in `evals/fixtures/`, one per concern (e.g. `core.json`, `direction.json`, `exits.json`, `spreads.json`, `regressions.json`). Run `ls src/intents/evals/fixtures/` for the current list.

## Scoring Rules

1. Outcome mismatch (EXECUTE vs SKIP) -> score 0. Becomes `hardFail` only if `'outcome'` is in the case's `mustMatch` array.
2. Outcome match with no expected signals -> score 1.0, pass.
3. Signal matching: match expected to actual by leg optionType composition, then positional fallback.
4. Fields scored per signal (only if present in expected): see `scoreSignal()` in scorer.ts. Includes `orderType`, `exitPercent`, `symbol`, and leg-level fields.
5. Leg fields: `side`, `strike` (tolerance-based), `optionType`, `expiry` (via `compareExpiry` with LEAP handling).
6. Legs matched by optionType first, then positional fallback.
7. `mustMatch` paths checked independently — any miss = `hardFail: true`, overrides score.
8. Pass threshold and tolerances defined as constants at the top of scorer.ts.

## Running Evals

```bash
npx tsx scripts/eval-orchestrator.ts                          # all fixtures
npx tsx scripts/eval-orchestrator.ts --tag skip               # filter by tag (skip cases need no LLM)
npx tsx scripts/eval-orchestrator.ts --case core-001          # single case
npx tsx scripts/eval-orchestrator.ts --provider xai --model grok-3  # different model
```

## Adding Test Cases

1. Pick the right fixture file by concern (or create a new one for a new category).
2. Each case needs: `id` (unique, prefix with filename slug), `description`, `input.rawHtml`, `expected.outcome`, `expected.signals` (if EXECUTE).
3. Expected signals use the `ExpectedSignal` type from types.ts. Legs use `ExpectedLeg` (partial `OptionLeg` pick).
4. Add `mustMatch` for fields that are critical (e.g. `signals[0].legs[0].side`, `signals[0].orderType`).
5. Add `tags` for filtering — at minimum the fixture filename slug.
6. For exit cases that need position matching, add `positions` array to `input`.
7. Run the eval to verify the case passes before committing.

## Watch Out

- The eval calls `resolveOrchestrator()` directly — changes to the parser, open-path, position-path, or LLM-path affect results.
- Skip cases (hard skip in parser) need no LLM provider or market data — fast and free.
- EXECUTE cases that hit the open-path need `DATABENTO_API_KEY` for market data.
- LLM-path cases need an LLM provider configured (see `--provider`/`--model` defaults in `scripts/eval-orchestrator.ts`).
- `positions` in fixture input feeds the `PositionProvider` — required for CLOSE/TRIM/LEG_OFF cases that go through position-path.

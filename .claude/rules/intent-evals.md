---
paths:
  - "src/intents/evals/**/*"
  - "scripts/eval-intents.ts"
  - "src/intents/extract-intent.ts"
---

# Intent Eval System

Evaluates the intent extraction LLM prompt against ground-truth test cases. Used to catch regressions when changing `extract-intent.ts` or the system prompt.

## Architecture

- **runner.ts**: Orchestrates eval runs. Calls the real agent loop (`runAgentLoop`) with the real `INTENT_SYSTEM_PROMPT` — no mocks. Bounded concurrency via `withConcurrency()`.
- **scorer.ts**: Compares actual vs expected output per-field. Produces a 0–1 score. `PASS_THRESHOLD = 0.8`. `mustMatch` fields cause hard fail regardless of score.
- **reporter.ts**: Terminal output with color. `printReport()` for single runs, `diffRuns()` for baseline comparison.
- **types.ts**: `EvalCase`, `EvalResult`, `EvalRunResult`, `EvalSource` interface.

## Sources

Two `EvalSource` implementations:
- **FixtureSource** (`sources/fixture.ts`): Reads JSON files from `evals/fixtures/`. Each file has `{ cases: EvalCase[] }`. Deterministic, checked into git.
- **DbSource** (`sources/db.ts`): Reads from `message_labels` table (reviewed=true). Generates `mustMatch` via `defaultMustMatch()` — action+symbol always, plus direction+strategy for OPEN, exitPercent for TRIM, targetStrategy for LEG_OFF.

## Fixture Files

JSON files in `evals/fixtures/` organized by concern:
- `core.json` — basic OPEN/SKIP cases
- `direction.json` — LONG/SHORT semantics (sold puts, credit spreads, lottos)
- `exits.json` — CLOSE/TRIM/LEG_OFF
- `spreads.json` — CDS/PDS with legs
- `regressions.json` — specific bugs that were caught and pinned

## Scoring Rules

1. Decision mismatch (EXECUTE vs SKIP) → score 0, immediate fail (not a hard fail).
2. Decision match with no expected signals → score 1.0, pass.
3. Signal matching: find actual signal by action+symbol, then score each expected field.
4. Legs matched by optionType first, then positional fallback. Expiry compared via `normalizeExpiry()`. Strikes compared with 0.5 tolerance.
5. `mustMatch` paths checked independently — any miss = `hardFail: true`, overrides score.

## Running Evals

```bash
npx tsx scripts/eval-intents.ts                          # fixtures, sonnet, temp=0
npx tsx scripts/eval-intents.ts --tag direction           # filter by tag
npx tsx scripts/eval-intents.ts --case core-001           # single case
npx tsx scripts/eval-intents.ts --provider xai --model grok-3  # different model
npx tsx scripts/eval-intents.ts --output run.json         # save for baseline
npx tsx scripts/eval-intents.ts --baseline run.json       # diff against saved run
```

## Adding Test Cases

1. Pick the right fixture file by concern (or create a new one for a new category).
2. Each case needs: `id` (unique, prefix with filename slug), `description`, `input.message`, `expected.decision`, `expected.signals` (if EXECUTE).
3. Add `mustMatch` for fields that are critical (direction, strategy for OPEN signals).
4. Add `tags` for filtering — at minimum the fixture filename slug.
5. Run the eval to verify the case passes before committing.

## Watch Out

- `temperature: 0` is default for reproducibility. Non-zero temps make results flaky.
- The eval uses the REAL agent loop and REAL prompt — changes to `INTENT_SYSTEM_PROMPT` or tool schemas affect results.
- `INTENT_VERSION` bump in `extract-intent.ts` invalidates cached intents in backtest but does NOT affect eval fixtures (they call the LLM fresh).
- DbSource requires DB connection — fixture source works offline.
- `promptHash` in results tracks which prompt version produced the run. Use `--baseline` diff to detect regressions across prompt changes.

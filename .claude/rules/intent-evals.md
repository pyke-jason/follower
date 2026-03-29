---
paths:
  - "src/intents/evals/**/*"
  - "scripts/eval-orchestrator.ts"
  - "src/intents/orchestrator/**/*"
  - "src/eval/**/*"
  - "src/local-api/routes/eval.ts"
  - "src/local-api/routes/web-queries-eval.ts"
---

# Eval Systems

This project has two separate eval systems. Know which one you are working in before making changes.

## System 1: Orchestrator Evals (fixture-based regression tests)

**Location:** `src/intents/evals/` + `scripts/eval-orchestrator.ts`
**Purpose:** Catch regressions when changing the parser, open-path, position-path, or LLM-path. Calls `resolveOrchestrator()` directly against fixture-defined test cases.

### Key Files

| File | Role |
|------|------|
| `src/intents/evals/scorer.ts` | Compares `OrchestratorResult` vs expected output per-field. `PASS_THRESHOLD = 0.8`. `mustMatch` fields cause hard fail regardless of score. |
| `src/intents/evals/reporter.ts` | Terminal output. `printReport()` for single runs, `diffRuns()` for baseline comparison. |
| `src/intents/evals/types.ts` | Shared eval types: `EvalCase`, `EvalResult`, `ExpectedSignal`, `EvalRunResult`. |
| `src/intents/evals/sources/fixture.ts` | Loads JSON fixtures from `src/intents/evals/fixtures/`. Each file has `{ cases: EvalCase[] }`. |
| `scripts/eval-orchestrator.ts` | CLI runner. Defaults: `--provider xai --model grok-4-1-fast-non-reasoning`. |

### Fixtures

JSON files in `src/intents/evals/fixtures/`, one per concern. Run `ls src/intents/evals/fixtures/` for the current list. Each case needs:

- `id` (unique, prefixed with filename slug)
- `description`
- `input.rawHtml` (the chat message HTML)
- `expected.outcome` (EXECUTE or SKIP)
- `expected.signals` (if EXECUTE) using `ExpectedSignal` type
- `mustMatch` array for fields that must match exactly (e.g. `signals[0].orderType`, `signals[0].legs[0].side`)
- `tags` for filtering (at minimum the fixture filename slug)
- `positions` array in `input` for CLOSE/TRIM/LEG_OFF cases (feeds the `PositionProvider`)

### Scoring Rules

1. Outcome mismatch (EXECUTE vs SKIP) -> score 0. Becomes `hardFail` only if `'outcome'` is in `mustMatch`.
2. Outcome match + no expected signals -> score 1.0, pass.
3. Signal matching: by leg optionType composition first, positional fallback second.
4. Fields scored per signal (only if present in expected): `orderType`, `exitPercent`, `symbol`, and leg-level fields (`side`, `strike` with tolerance, `optionType`, `expiry` via `compareExpiry` with LEAP handling).
5. Legs matched by optionType first, then positional fallback.
6. `mustMatch` paths checked independently -- any miss = `hardFail: true`, overrides score.

### Running

```bash
npx tsx scripts/eval-orchestrator.ts                                # all fixtures
npx tsx scripts/eval-orchestrator.ts --tag skip                     # skip cases (fast, no LLM/market data)
npx tsx scripts/eval-orchestrator.ts --case core-001                # single case
npx tsx scripts/eval-orchestrator.ts --provider xai --model grok-3  # different model
```

### Cost & Dependency Rules

These exist because the eval touches external APIs that cost money or require credentials:

- **Skip cases** (hard skip in parser): No LLM, no market data. Fast and free. Use `--tag skip` to run only these.
- **EXECUTE cases via open-path**: Need `DATABENTO_API_KEY` for market data. Databento charges per byte fetched.
- **LLM-path cases**: Need an LLM provider configured. Cost tokens per case.

### Do Not

- Do not add test cases that fail on commit. Run the eval and confirm the case passes first.
- Do not add position lookups to open-path fixtures or chain lookups to position-path fixtures. Keep concerns separate.
- Do not change `PASS_THRESHOLD` or scoring tolerances without re-running all fixtures and verifying no regressions.

---

## System 2: Parser/Labeling Evals (golden dataset)

**Location:** `src/eval/` + `src/local-api/routes/eval.ts`
**Purpose:** Measure classification accuracy of stored labels against human-verified golden labels. The label schema is shared with production intent parsing: one `Signal` type, no eval-only mapping layer.

### Key Files

| File | Role |
|------|------|
| `src/agent/schemas.ts` | Source of truth `SignalSchema` and `Signal` type used by labels, orchestrator, and tooling. |
| `src/db/schema.ts` | `EvalLabelData` type + `evalLabels` table. `label` and `humanLabel` store `Signal[][]` with eval metadata. |
| `src/eval/eval.ts` | Comparison logic. `computeEvalMetrics()` compares stored labels vs human-verified labels against the shared `Signal` fields. |
| `src/local-api/routes/eval.ts` | API routes for eval label CRUD. |
| `src/local-api/routes/web-queries-eval.ts` | Discrepancy review API (uses `discrepancyReviews` table, not `evalLabels`). |
| `.claude/skills/label/SKILL.md` | Human labeling workflow and examples. Use this instead of a deleted `src/eval/labeler.ts` agent script. |

### Label Schema

`EvalLabelData` has: `reasoning` (string), `isTrade` (boolean), `confidence` (`HIGH`|`LOW`), `trades` (array of arrays of `Signal`).

Each `Signal` has:
- `action`, `symbol`, `direction`, `strategy`
- `strikes`, `expiry`, `statedPrice`, `quantity`
- `exitPercent`, `targetStrategy`

Rules:
- `strategy` is nullable. `null` means the message is clearly a trade but the instrument is not explicit.
- `strikes` are flat on the signal. Do not reintroduce label-only `legs`, `optionType`, `isCredit`, or `instrumentKnown` fields.
- `ResolvedSignal.legs` in orchestrator execution is a different type and remains separate.

### Do Not

- Do not add a parallel eval-only schema. `Signal` is the only classification shape.
- Do not reintroduce compatibility shims for old flat `.signals` labels. The dataset was reset during consolidation.
- Do not conflate these two eval systems. Orchestrator evals test the full pipeline (parser + market data + LLM routing). Labeling evals test classification accuracy of the labeling agent against human ground truth.

# competent-darwin-146b66

## Goal
Pre-live hardening of IBKR symbology: (1) route multi-class share tickers (BRK.B, BF.B) through the sidecar using IBKR's required space-separator form, (2) fail hard on non-standard option multipliers (mini-options, multiplier != 100) that would silently mis-size orders by 10x, (3) fix a latent bug in `getPositions()` where whitespace collapse on `localSymbol` produced a 20-char string that fails `isOccOptionSymbol` (length === 21), (4) add a 24h TTL on stock conId cache to protect against stale ticker reuse, (5) add unit test coverage for symbology. Narrow, go-live-relevant broker correctness changes.

## Changes
- `src/broker/ibkr/symbology.ts` — adds `normalizeIbkrTicker()` (dot to space), `clearContractCache()`, 24h TTL on stock cache, hard-fail when contract multiplier != '100'.
- `src/broker/ibkr/client.ts` — `getQuote()` normalizes STK symbols via `normalizeIbkrTicker`; `getPositions()` drops the broken whitespace-collapse and uses `p.localSymbol` verbatim for option display symbol.
- `src/broker/ibkr/symbology.test.ts` — new test file covering `occToIBKR`, `normalizeIbkrTicker`, multiplier validation, and stock cache TTL/normalization.

## Justification per change
- `normalizeIbkrTicker` + STK path in `getQuote`/`resolveStockContract` — **JUSTIFIED**. IBKR TWS API requires space-separated class suffixes; sending `BRK.B` to sidecar will fail. Real correctness fix. Lives at the right boundary (broker impl), not pipeline.
- Multiplier hard-fail in `resolveContract` — **JUSTIFIED**. Mini-options (multiplier 10) would be silently 10x wrong-sized. Fail-closed at the broker boundary is correct; cache does not store the failure and a test asserts re-fetch after the error.
- `getPositions()` whitespace fix — **JUSTIFIED**. Previous `replace(/\s+/g, ' ').trim()` collapsed the required double-space padding in OCC format (21 chars → 20 chars), which fails `isOccOptionSymbol`. Any downstream OCC re-parse on `pos.symbol` would silently break. Fix is minimal.
- Stock cache 24h TTL + `clearContractCache` — **SUSPECT (borderline)**. "Ticker reuse after delisting" is rare for a single-user supervised system. `clearContractCache` is only used by tests per grep. Marginal value but cheap and tested.
- `symbology.test.ts` — **JUSTIFIED**. Tests real behavior: multiplier validation, retry-after-error cache miss, TTL boundary, ticker normalization, cache aliasing between `BRK.B` and `BRK B`. Not scaffolding.

## Concerns
- **Bloat (minor)**: `clearContractCache` is exported for tests only; acceptable given the TTL.
- **Theatre risk (minor)**: `STOCK_CACHE_TTL_MS` rationale thin for a single user; ~3 lines, not worth reworking.
- **Missing lesson file**: No `docs/lessons/2026-04-24-*.md` created for this worktree's IBKR changes despite project mandate.

## Verdict
**MERGE**. Three of four changes are direct, narrow pre-live correctness fixes: BRK.B routing bug, mini-option size-safety check, and the latent `getPositions` whitespace bug. The fourth (stock cache TTL) is slightly over-engineered for a single user but costs essentially nothing and comes with correct tests. Changes live at the right boundary (broker impl), contain no pipeline branching, no duplicated types, no shape-plumbing cruft. Tests would catch the exact regressions they guard. `normalizeIbkrTicker` is exported once and reused at both call sites rather than inlined.

## Required fixes
None.

## Reviewer verdict
**APPROVE** — Thesis claims check out end-to-end. Tried to falsify the three "JUSTIFIED" items and each one holds: `isOccOptionSymbol` at `src/lib/occ-symbology.ts:28` does require `symbol.length === 21`, so the prior `p.localSymbol.replace(/\s+/g, ' ').trim()` truly produced a 20-char string that would silently fail any downstream OCC re-parse; the multiplier `!== '100'` fail-hard fires before `contractCache.set()` so the cache never poisons on failure (explicitly covered by the "allows retry after fix" test); `normalizeIbkrTicker` is exported once and reused at both STK sidecar call sites (`client.ts:193` in `getQuote`, and inside `resolveStockContract` which is the path `placeOrder` takes at `client.ts:246`) with no inlined duplicates. Tests pass (20/20), tsc clean, knip shows no new orphans. `clearContractCache` is test-only as claimed.

### Agreements
- Multi-class share routing (BRK.B → BRK B), multiplier hard-fail, and OCC whitespace fix are narrow pre-live correctness wins.
- TTL is borderline-over-engineered but trivially small.
- Test file exercises real behavior (cache-miss-on-error, TTL boundary at 23h/25h, cache aliasing BRK.B ≡ BRK B), not scaffolding.

### Disagreements
- Thesis calls `getPositions` whitespace fix "JUSTIFIED" as a latent bug. It's more defensive-cleanup than active bug — grep shows no current downstream caller re-parses `BrokerPosition.symbol` via `isOccOptionSymbol`; `extractUnderlying` in `reconciler.ts:98` tolerates both formats. Fix is still correct (cheaper, clearer intent), but "latent" is the right framing, not "bug".

### Missed by thesis
- OCC underlying path in `resolveContract` (option quotes/orders for BRK.B options) still sends `params.symbol` unchanged. Not in scope for this worktree's stock-side framing, and OCC padding likely lacks dots anyway — but worth calling out so it isn't lost.
- Lessons file concern is correctly flagged but understated: project CLAUDE.md says lessons are **mandatory** after implementation sessions. `docs/lessons/` has four entries dated 2026-04-24 from other work, none for this worktree.

### Verdict reasoning
Three real correctness fixes at the right boundary (broker impl), one borderline-but-cheap TTL, solid tests, no pipeline branching, no shape-plumbing or type-duplication violations vs `.claude/rules/lessons.md`. Merge safely. Consider adding `docs/lessons/2026-04-24-ibkr-symbology.md` post-merge to honor the mandate.

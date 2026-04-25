# Worktree Audit: `upbeat-rubin-2190af`

## Goal

Two unrelated thrusts bundled in one worktree:

1. **Resilience for going live** — wrap the live runner's primary agent with a 429-rate-limit fallback to Claude Haiku, so primary throttling does not surface as MANUAL_REVIEW (i.e. a missed trade) in production.
2. **Parser/LLM precision tweaks** — hard-skip slash-prefixed futures (`/ES`, `/MES`, etc.); add LLM rubric guardrails so "Nc" cents annotations are not misread as CALL strikes and `for X% gain/profit` is not misread as `exitPercent`. Plus an associated canonical-trade text strip for unparenthesized "97c gain" P&L tails.
3. **Risk-check defensive path** — fix a `Number(count)` cast in `build-deps.ts` that produced a string-typed reconciliation alert count, and add an alert/log at the executor for the `!allowed && reason==null` condition that was the symptom.

## Changes

| File | Change |
|------|--------|
| `src/agent/fallback-agent.ts` (NEW) | `WithFallbackAgent` wraps two `Agent`s; on 429 from primary, calls fallback once; otherwise re-throws. |
| `src/live/runner.ts` | `getAgent()` constructs primary (default trade model — Sonnet) plus a hard-coded Haiku fallback, wraps both in `WithFallbackAgent`. |
| `src/intents/orchestrator/parser.ts` | New hard-skip `^\s*\/[A-Z][A-Z0-9]{0,4}\b` for `/ES`/`/NQ`/`/MES` etc., placed before badge logic so `[Short]` futures messages are skipped without LLM cost. |
| `src/intents/orchestrator/llm-path.ts` | Rubric expansions: extends futures hard-skip examples to enumerate MES/MNQ/MYM/M2K/slash-prefix; new rule `2b` "Nc in P&L is cents not call"; new CRITICAL block under rule 7 distinguishing "30% profit" (P&L) from "trim 30%" (exitPercent). |
| `src/intents/orchestrator/canonical-trade.ts` | Adds `\d+c (gain\|loss\|profit\|scratch)` trailing strip for unparenthesized cents tails. |
| `src/pipeline/build-deps.ts` | `getReconciliationAlertCount` now `Number(alerts[0]?.count ?? 0)` — Postgres `COUNT(*)` returns a string, the unwrapped value made `alertCount === 0` false in `risk-check.ts`, blocking trades with `reason=undefined`. |
| `src/pipeline/execute-resolved.ts` | Defensive: when `!risk.allowed && !risk.reason`, log error + critical alert, surface synthetic `blockReason` instead of literal "undefined" in the warn line. |

## Justification per change

- **Number cast fix** (`build-deps.ts`): Genuine bug. `risk-check.ts` only emits a `reason` string in named branches; if `alertCount` is the string `"0"` it satisfies neither `=== 0` nor `> 0`, producing `allowed=false, reason=undefined`. Correct, minimal, and exactly the right place to fix it (the source of the type confusion). **Required for live.**
- **Defensive log/alert in `execute-resolved.ts`**: Belt-and-suspenders for the same bug. Reasonable as a guard, but the fix is at the producer; the executor branch should never fire. Acceptable but bordering on cruft now that the upstream bug is fixed.
- **Futures slash hard-skip** (parser): Small, anchored, structural. Aligns with `orchestrator.md`'s "structural metadata, anchored regex, hard-skip-only" allowance. The author's claim "Hariseldon uses [Short]/[Exit] badges on futures" is plausible — a badged `/ES` message would otherwise reach the LLM. Saves tokens, low risk. The regex `[A-Z0-9]{0,4}` is narrow enough.
- **LLM rubric tweaks** (rule 2b cents, rule 7 critical block, rule 7 futures enumeration): These are sound corrections — well-known failure modes (`(58c gain)` mis-parsed as a 58 strike call, `for 30% profit` mis-parsed as `exitPercent=0.3`). The wording is precise and aligned with existing rubric voice.
- **Canonical-trade `\d+c gain` strip**: Belongs alongside the existing P&L strippers; the parenthesized variant was already stripped at line 93 (`\([^)]*\)` strips `(58c gain)`). The new rule covers the unparenthesized tail. Consistent with the existing pattern.
- **Fallback agent for live runner**: Defensible motivation (don't lose a live trade to a transient 429), but the implementation has substantive flaws — see Concerns.

## Concerns

### 1. Fallback lies about identity — pollutes the intent cache (CORRECTNESS BUG)

`WithFallbackAgent.identity` returns `this.primary.identity` unconditionally, but `src/intents/orchestrator/llm-path.ts:225` reads `agent.identity.model` to **key the LLM intent cache** (`messageIntents` table). If the fallback fires and Haiku produces a SKIP/EXECUTE/MANUAL_REVIEW, the result is written to the cache row keyed by `claude-sonnet-4-6`. Future hits on the same `messageId` retrieve a Haiku-classified result and **return it as Sonnet's**.

Same problem in `src/intents/orchestrator/index.ts:340` for non-LLM-path decisions, though those are deterministic so the mis-attribution is "only" telemetry. The LLM path is the load-bearing case.

This is the dangerous-quiet-degradation failure mode the rubric explicitly warns about.

### 2. Fallback fires silently — only `log.warn`, no alert

For a single-user system going live, having a model silently swap to a cheaper/weaker classifier with only a log line is wrong-shaped. There is no `sendSystemAlert` in the fallback path, no metric, no annotation on the cached intent record. The rubric question "ALERT and stop, rather than try a worse model" is real: a 429 in a personal account usually means you typed your card wrong, not transient pressure — silent fallback hides the operational issue.

### 3. Fallback identity should be config-driven, not hard-coded

`runner.ts` hard-codes `claude-haiku-4-5-20251001`. The default trade model is environment-overridable (`TRADE_MODEL_PROVIDER` / `TRADE_MODEL`), but the fallback is not. If someone sets the primary to a Grok model, the fallback is still Anthropic Haiku — a cross-provider swap that may not be desired and certainly is not announced.

### 4. Wrapper is at the wrong layer — backtest does not get it

The fallback is applied in `live/runner.ts` only; `backtest/runner.ts:202` constructs the agent without wrapping. If the backtest hits a 429 mid-replay, it errors out instead of falling back. If the choice is "live needs this, backtest does not", that is fine but should be documented; if not, it belongs in `agent/factory.ts` behind a flag so both paths share one decision.

The rubric noted "the fallback wrapper should be at the `Agent` interface, not in `live/runner.ts`" — correct. Putting it in the factory (or as `createAgentWithFallback`) keeps a single construction site; the current structure means future agents (eval, classify) will not get fallback unless someone remembers to wrap them.

### 5. INTENT_VERSION not bumped despite parser AND llm-path prompt changes

`orchestrator.md`: *"Bump `INTENT_VERSION` when changing `NLU_SYSTEM_PROMPT`, tool schemas, parser logic, or prompt construction — this invalidates all cached results."* This worktree changes both `parser.ts` (new hard-skip) and `llm-path.ts` (new rubric items 2b and 7-CRITICAL) and leaves `INTENT_VERSION = 60`. Stale cache entries from before this worktree will hide the new "Nc cents" / "30% gain" rules from any message that already has a cached decision. **This actively defeats the value of the rubric tightening.**

### 6. No tests for the new behaviors

- No parser test for `/ES`, `/MES`, `/NQ`. The existing fixture corpus has nothing covering slash-prefix futures.
- No `canonical-trade.test.ts` case for unparenthesized "97c gain"/"58c loss" tails.
- No `fallback-agent.test.ts` covering 429 trip, non-429 passthrough, identity-leak, or cache-pollution scenarios.
- No `docs/lessons/2026-04-24-*.md` for any of these decisions.

The CLAUDE.md "lessons mandatory" rule is flatly violated.

### 7. Defensive code in `execute-resolved.ts` is now dead-on-arrival

Once `Number(...)` is in place upstream, `risk.allowed=false` with `reason=undefined` cannot occur from this path. The defensive log/alert/synthetic-reason code becomes paranoia that will never fire and now reads as confusing — it tells future readers "there's a known coercion bug" when there isn't, anymore. Either delete it or convert it into a generic invariant (`if !allowed and !reason → bug, alert`) without naming the specific cause that has been fixed.

## Verdict: REWORK

The bundle mixes one clearly-correct fix (`Number` cast for `COUNT(*)`), one defensible-with-caveats LLM precision pass (cents/percent rubric, futures hard-skip, P&L tail strip), and one fallback-agent that as written introduces a new correctness hazard (identity-leak into intent cache) and a "silent quality degradation" failure mode that the rubric explicitly warned against. Going live with this worktree as-is would mean that the first time the primary model rate-limits, classifications get silently downgraded to Haiku, written to the intent cache as if Sonnet produced them, and replayed for all future identical-text messages. That is exactly the "fallback that quietly degrades trade quality is dangerous, not safe" anti-pattern.

The Number cast and parser/LLM tweaks could merge today behind an `INTENT_VERSION` bump. The fallback agent must be reworked or dropped before live.

## Required fixes

1. **Bump `INTENT_VERSION`** in `src/intents/orchestrator/intent-cache.ts` (60 → 61). Required because `parser.ts` and `llm-path.ts` rubric both changed.
2. **Make `WithFallbackAgent.identity` reflect what actually ran**, OR include the active model in `AgentResult.model` and key the intent cache off `result.model` instead of `agent.identity`. The cache must never store a Haiku decision under a Sonnet key. Simplest fix: track `lastUsedIdentity` on the wrapper and have callers read `result.model` for cache writes.
3. **Alert when fallback fires.** `sendSystemAlert({ severity: 'warning', title: 'Primary agent rate-limited, falling back', message: '...' })` inside the catch. Single-user system; the user must know.
4. **Move fallback construction to `agent/factory.ts`** (e.g. `createAgentWithFallback(primary, fallback)`), and call it from both `live/runner.ts` and any other production agent site. Keep `backtest/runner.ts` opt-out if intentional.
5. **Drive fallback identity from config/env**, not a hard-coded string. Suggest `TRADE_MODEL_FALLBACK_PROVIDER` / `TRADE_MODEL_FALLBACK`.
6. **Add tests**: parser test for `/ES`, `/MES`; canonical-trade test for `97c gain` tail strip; fallback-agent unit tests for 429 dispatch, non-429 propagation, identity reporting, both providers' error shapes.
7. **Add a lesson** at `docs/lessons/2026-04-24-rate-limit-fallback.md` explaining (a) why fallback over alert-and-stop, (b) the identity-vs-cache contract, (c) which paths get the wrapper and why.
8. **Trim or generalize the defensive block in `execute-resolved.ts`**. If kept, drop the specific `getReconciliationAlertCount` mention; it now reads as a tombstone for a fixed bug. Prefer: `if (!risk.allowed && !risk.reason) { log.error('risk check invariant violated: !allowed without reason'); ... }`.
9. **Verify nothing else depends on `agent.identity`** lying — quick grep on `agent.identity` across `src/` (already done; the LLM cache write at `index.ts:340` and `llm-path.ts:225` are the load-bearing sites).

## Reviewer verdict

**REWORK** (concurs with thesis).

### Agreements (verified independently)

- **Parser sync/zero-I/O preserved.** `parser.ts` adds only `FUTURES_SLASH_RE = /^\s*\/[A-Z][A-Z0-9]{0,4}\b/i` and a `.test()` call before badge logic. No imports added, no I/O, no async. Sync contract intact.
- **No `if (isBacktest)` violations.** `build-deps.ts` and `execute-resolved.ts` diffs are uniform; no backtest branching introduced.
- **Identity-leak is real and load-bearing.** Confirmed `WithFallbackAgent.identity` returns `this.primary.identity` unconditionally (fallback-agent.ts:30). Confirmed `llm-path.ts:225` (`const model = agent.identity.model`) writes that to the `messageIntents` cache row. A 429 → Haiku run will be cached as Sonnet's output and replayed forever for identical text. This is the canonical "silent quality degradation" hazard.
- **INTENT_VERSION still 60.** Confirmed at `intent-cache.ts:24`. `orchestrator.md` mandates a bump on parser/prompt changes; both changed here. Stale cache entries hide the new rules — the rubric tightening is partially neutered until cache turnover.
- **Lessons file absent.** `docs/lessons/` has no `2026-04-24-rate-limit-fallback.md` (or similar for parser/cents). CLAUDE.md "lessons mandatory" violated.
- **Wrapper at wrong layer.** `live/runner.ts` only; `backtest/runner.ts` and other agent sites (eval, classify) bypass it. Belongs in `agent/factory.ts`.
- **Silent fallback / no alert.** Only `log.warn`; no `sendSystemAlert`. For a single-user system, a 429 is operational signal, not noise.

### Disagreements / nuance

- The thesis's framing of the `execute-resolved.ts` defensive block as "dead-on-arrival" is slightly strong — it does also cover any *other* future code path that returns `!allowed && !reason`. Concur it should be generalized (drop the named-bug reference) rather than deleted.
- Hard-coded Haiku string: also note Haiku here is a different *capability tier* model. Even without provider mismatch, Haiku trade-classification accuracy vs Sonnet is unmeasured in this codebase. The fallback trades a known-good classification for an unmeasured one — silently. Aggravates concern #2.

### Missed by thesis

- `WithFallbackAgent` has **no test file** — `src/agent/fallback-agent.test.ts` does not exist. Knip will flag it as orphan if not exercised, and `isRateLimitError`'s message-string heuristic (`includes('429')`) is fragile and untested.
- The `is RateLimitError` predicate matches any error whose message string contains `"429"` — including unrelated text like "received 4290 bytes". Low-probability but the cheap fix is to require `statusCode === 429` only.
- `_agent` is a module-level singleton; if `getAgent()` is ever called before primary's API key is configured, both `createAgent` calls run sequentially, and a fallback-creation failure aborts startup even if primary is fine. Fail-closed on optional resilience is a regression.

### Verdict

**REWORK.** The `Number()` cast and parser/canonical-trade/llm-path tweaks are merge-ready behind an `INTENT_VERSION` bump. The fallback agent as written introduces a correctness hazard (cache pollution via leaked identity) plus a silent-degradation failure mode and is at the wrong architectural layer. Required fixes 1, 2, 3, 4 from the thesis are non-negotiable before this hits live; 5–9 are quality-of-life but should land together.

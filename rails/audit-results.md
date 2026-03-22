# Orchestrator Parser Audit Results

**Date:** 2026-03-21
**Corpus:** 83,624 messages — 100% labeled by 50+ independent agents

## Executive Summary

The parser is **good at catching real trades (97.3% recall)** but **has a meaningful false positive problem (8.4%)** — it tries to execute 1,352 messages that are actually commentary. It also routes 19,154 commentary messages unnecessarily to the LLM path.

| Metric | Value |
|--------|-------|
| Precision | **91.7%** |
| Recall | **97.3%** |
| F1 Score | **94.4%** |
| False Negatives | 417 (real trades parser skipped) |
| False Positives | 1,334 (commentary parser tried to execute) |
| LLM-routed trades | 5,491 (real trades that need LLM — deterministic can't handle) |
| LLM-routed commentary | 19,096 (commentary unnecessarily routed to LLM) |

## Confusion Matrix

```
                    Label:SKIP  Label:EXEC  Label:AMBIG
Parser:SKIP          42,521         413            0
Parser:EXECUTE        1,352      14,743            0
Parser:NULL(→LLM)   19,154       5,441            0
```

## Critical Issues (Priority Order)

### 1. FALSE POSITIVES: 1,344 commentary messages classified as EXECUTE

The parser produces deterministic EXECUTE for 1,344 messages that agents labeled as SKIP (commentary). This means the system would attempt to place broker orders on non-trades.

**Breakdown:**
- **993 false OPEN** — mostly badgeless messages with "bought/buying/sold/selling/wrote" verbs
- **247 false ADD** — "adding" used in non-trade context
- **103 false CLOSE** — exit verbs in commentary
- **9 false TRIM** — fraction language in commentary

**Root cause:** Badgeless action detection (parser lines 883-897) matches common English words without sufficient structural guards. See `scratchpad/audit-badgeless-opens.md` for detailed analysis.

**Fix:** Add `no_badge_open` complexity flag for ALL badgeless OPENs. The parser already does this for exits (`no_badge_exit`). Same principle.

### 2. FALSE NEGATIVES: 333 real trades skipped

**Breakdown:**
- **357 PLTR blacklist** — design choice, not a bug. But exits on PLTR create orphaned positions.
- **55 calendar/time spread** — multi-action messages (Exit Long X + Exit Short Y) falsely triggering the Long+Short→calendar skip.
- **1 monitoring** — edge case.

**Fix for calendar (37 bugs):** When Exit + Long + Short badges all present AND multiple symbols → route to LLM instead of hard-skipping.

**Fix for PLTR (295):** Consider exempting exits from the blacklist so positions can be closed.

### 3. ACTION MISMATCHES: 809 cases where parser and label disagree on action type

**Top mismatches:**
- **457 TRIM→CLOSE** — parser says TRIM, agents say CLOSE. The parser detects fraction words ("half", "%") but agents determined these referred to position sizing or "remaining half" closes, not partial exits.
- **125 OPEN→ADD** — parser says OPEN, agents say ADD. The parser can't check existing positions (zero I/O), so it can't know if this is a new position or an add.
- **109 CLOSE→TRIM** — parser says CLOSE, agents found partial exit language the parser missed.
- **40 LEG_OFF→CLOSE** — parser detects leg-off language, agents determined it was a full close.
- **39 CLOSE→LEG_OFF** — parser says CLOSE, agents identified it as closing one leg of a spread.

### 4. STRATEGY MISMATCHES: 566 cases

**Top mismatches:**
- **279 CALL→STOCK** — parser detected "calls" keyword, but agents determined the trade was stock (e.g., "calls" used in commentary within a stock trade message).
- **106 PUT→CALL** — parser detected "puts", agents determined CALL.
- **55 PUT→STOCK** — parser detected "puts" in stock trade context.
- **37 STOCK→CALL** — parser defaulted to STOCK, agents found it was actually options.

### 5. DIRECTION MISMATCHES: 695 cases

**Top mismatch:**
- **634 LONG→SHORT** — parser says LONG, agents say SHORT. Mostly "Short badge + puts" where the trader is buying puts (LONG direction) but agents labeled as SHORT (matching the badge's bearish view). This is a LABELING DISAGREEMENT about semantics, not necessarily a parser bug.

### 6. LLM WASTE: 19,154 commentary messages routed to LLM

The parser sends 19,154 messages to the LLM that are actually commentary (agents labeled SKIP). This wastes tokens for zero value.

**Biggest driver:** `ambiguous_strategy` flag (4,755 messages). See `scratchpad/audit-ambiguous-strategy.md` — 63% of these are unambiguously STOCK trades with bare prices (no `$` prefix).

**Fix:** Recognize bare prices >= $10 as stock prices. Would save ~3,542 LLM calls.

## Recommended Parser Fixes (Priority Order)

| # | Fix | Impact | Risk |
|---|-----|--------|------|
| 1 | Add `no_badge_open` flag for all badgeless OPENs | -993 false positives | None |
| 2 | Bare price >= $10 → STOCK | -3,542 LLM calls | Low |
| 3 | Strike+c/p pattern (170p, 245c) → CALL/PUT | -307 LLM calls | None |
| 4 | Calendar skip: exempt multi-symbol Exit messages | -37 false negatives | Low |
| 5 | Futures regex: require `/` prefix for ES/NQ/RTY/YM | -3 false negatives | None |
| 6 | PLTR blacklist: exempt exits | -295 false negatives | Design decision |
| 7 | Separate "selling" (commentary) from "sold" (trade) | -290 false positives | Low |

## Files

| File | Contents |
|------|----------|
| `scratchpad/audit-parser-results.json` | Raw parser statistics |
| `scratchpad/audit-exit-badge-skips.md` | Exit badge skip investigation |
| `scratchpad/audit-badgeless-opens.md` | Badgeless OPEN investigation |
| `scratchpad/audit-ambiguous-strategy.md` | Ambiguous strategy flag investigation |
| `scratchpad/parser-comparison-results.json` | Full comparison data |
| `rails/labeling-methodology.md` | How agents labeled messages |
| `rails/parser-rules.md` | Complete parser rules inventory |

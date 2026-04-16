# Eval Label Relabel — Price Implies STOCK

## Problem
The eval labeler left `strategy: null` on 74% of trade labels — even when a specific dollar price was stated (e.g., "Short GPC 111.71"). It also hallucinated `strategy: "CALL"` on stock exits with cent-denominated P&L ("18c loss"). Both errors made the golden dataset unreliable for measuring parser accuracy.

## Decision
Added three rules to SKILL.md and relabeled all 2,215 badged messages from the last month:
1. **Price implies STOCK** — a stated dollar price with no options language (strikes, expiry, calls/puts/spread) means `strategy: "STOCK"`. Only use `null` for bare trades like "Long MP" with no price.
2. **Cent P&L confirms STOCK** — "18c loss", "-23c loss", "$.40 gain" are stock P&L, never CALL.
3. **Fractions near trim = quantity** — "3/4" in "trim 3/4 of FSLY" is `exitPercent: 0.75`, not expiry March 4th. Use message date as sanity check.

## Key Files
- `.claude/skills/label/SKILL.md` — rules 8, 8a, 8b updated; examples added
- `src/db/schema.ts` — `eval_labels` table (unchanged, just data)

## Watch Out
- Sub-agents used non-standard action values (BUY/SELL/SHORT instead of OPEN/CLOSE) and numeric confidence (0.99 instead of HIGH) — required post-insert fixes. Future relabels should validate against the schema enum values.
- Some agents set `statedPrice` on P&L exit descriptions ("$2.20 per share profit") when it should be null. Spot-check exits during review.
- 104 labels still have `strategy: null` — these are legitimate bare trades with no price or instrument clues.

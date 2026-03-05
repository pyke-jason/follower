Problem: 12 exit messages routed to LLM unnecessarily due to `relational` complexity flag ("ty Hari", "from yesterday"). These are commentary, not signal modifiers. Also `EXIT_VERB_RE` missed "took nice profits" (qualifier between "took" and "profits"), and "partial" didn't trigger TRIM.

Decision:
1. Suppress `relational` flag AFTER action determination, only for position-reducing actions (CLOSE/TRIM/LEG_OFF), guarded by multi_ticker and mixed_action.
2. Expand EXIT_VERB_RE: `took profits?` → `took\s+(?:\w+\s+)?profits?` to match "took nice/small/partial profits".
3. Add FRACTION_PARTIAL_RE for "partial" → exitPercent=0.5 (matches existing TRIM default in position-path.ts).

Key Files:
- src/intents/orchestrator/parser.ts — all three regex/logic changes
- src/intents/evals/fixtures/deterministic-exits.json — 12 new eval cases
- src/intents/evals/fixtures/exits.json — updated exits-009 (partial now triggers TRIM)

Watch Out:
- The relational suppression MUST stay after action determination (line ~812). Moving it to where relational is first set (~653) would be wrong because action isn't known yet.
- Guards (multi_ticker, mixed_action) are critical. Without them, "Exit AAPL ty Pete, also buying GOOG" would suppress relational and route deterministically despite being genuinely complex.
- FRACTION_PARTIAL_RE is checked after TWO_THIRDS/HALF/THIRD/QUARTER — order matters for specificity (though "partial" doesn't conflict with any).
- extractExitPercent is only called inside badge-gated or EXIT_VERB_RE-gated blocks, so "partial fill on open" can't trigger false TRIM.

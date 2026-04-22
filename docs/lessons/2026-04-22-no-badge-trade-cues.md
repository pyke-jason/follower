Problem
The orchestrator only hard-skipped no-badge messages when they also lacked both a symbol and an action. That kept too many obvious no-badge commentary messages on the LLM path.

Decision
Add a narrow no-badge trade-cue gate in the parser. Messages with no trade badge now hard-skip unless they have both an extracted symbol and at least one strong trade cue such as action language, option/spread notation, price or size notation, or compact room shorthand like `OPEN`.

Key Files
src/intents/orchestrator/parser.ts
src/intents/orchestrator/parser.test.ts
src/intents/orchestrator/parser.no-badge-corpus.test.ts
scripts/export-no-badge-trade-corpus.ts

Watch Out
The acceptance bar is zero false negatives on the current labeled corpus, not a claim about all future messages. Keep the cue list aligned with real regressions and preserve common room misspellings like `sclaing out`.

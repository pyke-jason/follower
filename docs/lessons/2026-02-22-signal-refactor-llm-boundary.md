Refactored the boundary between LLM intent extraction and deterministic pipeline execution.

Problem
A UNH CDS trade in backtest showed only the entry message in the sidebar because the close never linked. Root cause: the LLM called get_quote("UNH"), got the equity price ($353), and set it as limitPrice on a CDS spread worth ~$3. The SELL LIMIT at $353 never filled, so the sim-broker auto-expired the position with no message linkage. Found 5 more signals with the same bug (MNDY, W, CRSP, GLW, SPY).

Decision
Draw a hard line: LLM parses text into structured intent, pipeline computes all numbers from market data. Removed get_quote tool from intent extraction (quotes already prefetched into prompt). Renamed limitPrice to statedPremium (informational only, never used for orders). Moved strike inference from LLM heuristics to deterministic code (inferATMSpread/inferATMStrike). All pipeline actions now use MARKET orders. Pipeline fetches broker quote for entry price sizing instead of using LLM-provided values. Bumped INTENT_VERSION 3 to 4.

Key Files
src/agent/schemas.ts — limitPrice removed, statedPremium added, legs-required refine removed
src/backtest/occ-symbology.ts — exported strikeInterval, added inferATMSpread, inferATMStrike, spreadWidth
src/lib/et-date.ts — added nextFriday(referenceDate)
src/pipeline/execute.ts — added resolveSignalLegs, getEntryPriceEstimate; all executors pass undefined for limitPrice
src/trading/trade-agent.ts — tolerates missing legs, skips sizing/buildOrderFromSignal when legs absent
src/intents/extract-intent.ts — removed get_quote tool, rewrote prompt for statedPremium, removed inferring_strikes section
src/agent/tool-factory.ts — submitDecisionTool uses statedPremium, added LEG_OFF and targetStrategy
src/agent/trade-agent.ts — SYSTEM_PROMPT updated for statedPremium
src/lib/eval.ts, web/lib/eval-helpers.ts, web/app/messages/intent-strip.tsx — updated signal field references

Watch Out
The trade-agent's sizing uses statedPremium (which may be 0) as a fallback when legs are missing — this is a gate check only, the pipeline re-sizes with a real broker quote. INTENT_VERSION bump forces re-extraction of all cached intents (~$5-15 cost). Broker-level limitPrice on OrderParams is unchanged — only the signal-level field was renamed. Live trading path becomes MARKET-only for now (no active live options trading).

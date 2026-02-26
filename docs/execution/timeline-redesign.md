# Timeline Redesign — Execution Log

## Goal
Make the trade detail page (and its upstream trade list from backtest detail) the most helpful possible view. Iterate using Playwright to critique and improve.

## Key Files
- `web/app/components/decision-timeline.tsx` — UnifiedTimeline component
- `web/app/trades/[id]/page.tsx` — Trade detail page (uses UnifiedTimeline)
- `web/app/components/badge.tsx` — Badge colors

## Test URL
http://localhost:3000/trades/fd6b0759-792f-4007-8488-79937b6dbfa9?run=230e8a54-8c21-46f5-8951-9fd0b1b30768

## Iteration Log

### Round 1 — Initial assessment
Screenshot shows the unified timeline rendering. Issues identified:

1. **Sort order wrong**: Trade events (OPEN/CLOSE) sort before decision events (PARSED/SIGNAL) because trade event timestamps are the actual trade time, while decision `createdAt` is the DB insert time. In backtests these can differ wildly. Need to interleave decisions AROUND the trade events they produce — group by message, not by raw timestamp.

2. **Rail alignment broken**: Trade event dots use `left-0 h-[10px] w-[10px]` but decision dots use `left-[1px] h-[8px] w-[8px]` — they don't center on the rail line at `left-[4px]`. Need consistent centering.

3. **"RESULT FAIL" is confusing**: The SETTLED+FAIL events exist because the order manager's limit chase timed out (the sync fill check failed), BUT the order was actually filled asynchronously. The trade DID succeed — OPEN and CLOSE events prove it. The FAIL is an internal pipeline status, not the real outcome. Options:
   a. Hide SETTLED events when the trade succeeded (there's a trade event proving it)
   b. Relabel: "Order timeout — filled asynchronously"
   c. Show but visually demote (very faded)
   Going with (a): filter out SETTLED events whose signal has a matching trade event.

4. **"strikes 8.4" noise**: The parse result has `strikes: [8.4]` which is a parsed premium candidate misattributed to strikes. Should filter out strikes for STOCK strategy trades.

5. **Message quote showing twice**: Both PARSED events show their respective messages, which is good.

### Round 2 — Fixes applied
- Fix sort: Group decision events per-message, interleave around corresponding trade events
- Fix rail: All dots centered on the same line
- Filter SETTLED when trade event proves success
- Strip "strikes" from STOCK parse results
- Clean up visual spacing

### Round 3 — Contrast and alignment
- Bumped event label opacity from /40 to /60+
- Fixed rail dot centering with explicit pixel math
- Added message quotes for PARSED events
- Improved reasoning text contrast

### Round 4 — Card container + visual hierarchy + options support
- Wrapped timeline in `<Card>` for visual cohesion with trade info card
- "EXECUTION TIMELINE" header (small caps tracking-widest)
- Trade events (OPEN/CLOSE/TRIM) now PRIMARY anchors: 13px dots, bold "Opened"/"Closed" labels
- Decision events SECONDARY: 8px dots, smaller labels
- Phase separator: detects messageId change or trade→decision transition, renders `hr` + extra spacing
- Reasoning moved to its own line (was crammed into badge row)
- Hidden duration when <10ms (CHASE "0ms" was noise)
- Chase format: "×6" instead of "step 6"
- Fixed SETTLED detail: no longer shows duplicate signal data (was falling through to `snap.signal` before SETTLED handler)
- Signal index `#0` hidden (only shown when >0, i.e., multiple signals)
- Tested on STOCK trade (TXN) and OPTIONS trade (MSFT PDS with spread legs, leg-off)
- Options renders well: spread SIGNAL shows two leg chips (BUY/SELL), strikes Kv, "Leg Off" trade event

### Round 5 — Cross-scenario testing + final polish
- Tested TRIM trade (GNRC: Opened 10 → Trimmed -5): amber dot, minus prefix, clean
- Tested trade-events-only (no decisions): timeline renders just trade events in card
- Verified exit PARSED message quotes render correctly (close message passed via `timelineMessages`)
- Checked full two-column layout at 1600px: trade info + timeline on left, chat context on right
- Checked backtest detail trades tab: inline expander (TradeStoryExpander) uses separate CompactEventChain — works independently of the new timeline
- No TypeScript errors in modified files (decision-timeline.tsx, trades/[id]/page.tsx)
- Phase separator bumped from `bg-border/30` to `bg-border/50` for visibility

### Round 6 — Data enrichment (leg-off, route, tradeId)
User feedback on META CDS trade: "not enough information", "nothing about the leg off trade",
"no information about the orchestrator route", "how is SIGNAL and PARSED different?"

Root cause analysis:
1. **Missing leg-off decisions**: `emitOrchestratorEvents` put `tradeId` in snapshot payload but not
   in `opts` → DB `trade_id` column was NULL → `getDecisionsForTrade` couldn't link them.
2. **No route info**: Orchestrator's deterministic/LLM routing decision was never captured in events.
3. **Intermediate messages invisible**: Leg-off message wasn't source or close, so query missed it.

Backend fixes:
- `src/intents/orchestrator/index.ts`: Added `route` param ('deterministic'|'llm'|'hard-skip') to
  `emitOrchestratorEvents`, included in PARSED snapshot. Added `tradeId` to SIGNAL_RESOLVED opts.
- `web/lib/queries.ts`: Two-step query — first find messageIds via trade_id, then get ALL events
  for those messages (catches PARSED events without trade_id).
- `web/app/trades/[id]/page.tsx`: Fetch intermediate messages (leg-off) discovered via decisions.

Frontend:
- `decision-timeline.tsx`: Route badge on PARSED events — green for deterministic, purple for LLM.

Backfilled existing data: 351 deterministic + 228 LLM routes from token-count heuristic.
Backfilled SIGNAL_RESOLVED trade_id from snapshot (65 rows).

Verified on META CDS (2eab45a1): entry→leg-off→exit all showing with route badges.
Verified on TXN STOCK (fd6b0759): LLM badge on entry PARSED, deterministic on close PARSED.

### Current state
The trade detail page tells a complete story:
1. Trade info card — who, what price, what P&L
2. Execution Timeline card — how the signal was parsed, what route was used, what order was placed, how it was chased/filled
3. Chat Context — the surrounding messages from the trader

Four trade types verified:
- **STOCK** (TXN): PARSED(llm)→SIGNAL→CHASE→Opened → PARSED(det)→SIGNAL→Closed
- **OPTIONS CDS** (META): PARSED(det)→SIGNAL(spread)→Opened → PARSED(det)→SIGNAL→LegOff → PARSED(det)→SIGNAL→Closed
- **OPTIONS PDS** (MSFT): PARSED→SIGNAL(spread, 2 legs)→Opened→LegOff → PARSED→SIGNAL→RESULT→Closed
- **TRIM-only** (GNRC): Opened→Trimmed (no decision events)

### Potential future improvements
- Phase separator labels ("Entry" / "Exit") — subtle but may add clarity
- Fill quality data inline in the timeline (slippage per fill)
- Backtest trades inline expander could use the new timeline format
- Test with SKIP/FAIL outcomes when data becomes available
- Mobile/responsive testing (currently only tested at 1400-1600px)

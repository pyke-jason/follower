ABNB Two-Trades-Per-Message Investigation (2026-02-23)

Problem

During backtest e49ee588, the message "Short ABNB using $127 Puts for $4.15 - 15 Contracts - 9/12" from hariseldon produced TWO separate trades instead of one. Investigation was launched to determine if the bug was in intent extraction, signal processing, pipeline execution, or message deduplication.

Investigation Summary

Examined the entire signal flow from chat message → intent extraction → signal parsing → runner loop → trade agent → pipeline → recordTrade. No bugs found in the infrastructure; the code works as designed. The root cause is LLM behavior during intent extraction.

Root Cause: Multi-Signal Parsing in Ambiguous Messages

The intent extraction LLM parses messages and can emit MULTIPLE signals from a single message. This is explicitly designed behavior, called out in the system prompt:
  - "Messages may contain multiple signals ("Exit TXN, Short TSLA") -- return ALL in the signals array."
  - The AgentDecisionSchema field `signals` is an array type: z.array(SignalSchema)

For the ABNB message, the phrase "Short ABNB using $127 Puts" is ambiguous:
  - Interpretation A (trader intent): "I'm bearish on ABNB, using put options as my vehicle" (1 logical trade)
  - Interpretation B (literal parsing): "Short ABNB" AND "using puts" (2 separate trades)

The LLM, when processing this message, likely extracted:
  1. Signal 1: { action: OPEN, symbol: ABNB, direction: SHORT, strategy: STOCK }
     (from the preamble "Short ABNB")
  2. Signal 2: { action: OPEN, symbol: ABNB, direction: LONG, strategy: PUT, legs: [{strike: 127, ...}] }
     (from "using $127 Puts")

Code Flow After Two Signals Extracted

Once the LLM emits 2 signals, the runner processes them independently with no aggregation:

  src/backtest/runner.ts:673-676
    for (const signal of signals) {
      const actions = await btCtx.tradeAgent.onSignal(signal, msg.author, ...);
      allActions.push(...actions);
    }

  Each signal → tradeAgent → PLACE_ORDER action → executeSignal() → recordTrade()
  Signal 1 (SHORT STOCK) → Trade #1 in DB
  Signal 2 (LONG PUT) → Trade #2 in DB

Why No Deduplication Caught This

Three layers were examined for deduplication; all work as designed:

1. Message-level deduplication (runner.ts:369-421)
   - Phase 2 loop processes each message once: for (let i = 0; i < tradableMessages.length; i++)
   - No check for "already processed" message IDs
   - This is correct — duplication does not come from the message being processed twice

2. Signal-level deduplication (runner.ts:673-676)
   - Signals array from intent is processed blindly: for (const signal of signals)
   - No aggregation, no "is this signal similar to a previous one?"
   - This is correct — the design permits multiple signals per message

3. Pipeline-level deduplication (execute.ts:709-731)
   - executeSignals() loops: for (const signal of signals)
   - One PipelineResult per signal, no merging
   - This is correct — signals are independent executable units

Conclusion: The Bug Is in the LLM Intent Prompt

The system prompt for intent extraction does not clarify how to handle phrases like "Short [equity] using [options]". Trader parlance suggests this should be ONE signal (the options position), but the current prompt can lead the LLM to decompose it into two.

The Fix

Add a clarifying example to the INTENT_SYSTEM_PROMPT in src/intents/extract-intent.ts:

  <example>
  <input>Short ABNB using $127 Puts for $4.15</input>
  <reasoning>
  "Short" describes the stock view (bearish). "using [options]" means the options are the PRIMARY vehicle.
  This is a single logical trade: LONG puts on a bearish view.
  Omit the "Short" as a separate signal — the put purchase IS the trade.
  </reasoning>
  submit_decision(EXECUTE): action OPEN, symbol ABNB, direction LONG, strategy PUT, legs [BUY 127P], statedPremium 4.15
  </example>

Key Files

  src/intents/extract-intent.ts (INTENT_SYSTEM_PROMPT, line 47-208)
  src/backtest/runner.ts (processMessage, line 673-676 — signal loop)
  src/agent/schemas.ts (AgentDecisionSchema.signals, line 57)
  src/pipeline/execute.ts (executeSignals, line 709-731)

Watch Out

- The multi-signal design is intentional for messages like "Exit TXN, Short TSLA" (truly two trades).
- The fix must not break that case — keep the array support, just clarify the ambiguous case.
- Consider adding similar examples for other option trading phrases: "short X puts", "long X calls using spreads", etc.
- Test the prompt change on historical messages with option trades to ensure no regressions.

/**
 * LLM path — natural language understanding for messages that couldn't be
 * resolved deterministically by the parser.
 *
 * Used for:
 * - Casual exit language ("took profits on CRWV calls this morning")
 * - Follow-trade patterns ("following Dave on MSTR")
 * - Multi-trade decomposition (two trades in one message)
 * - Leg-off instructions ("exit the spread, hold straight calls")
 * - Ambiguous action classification
 *
 * The LLM only handles what the parser couldn't: NLU. Direction rules, PCS
 * normalization, and badge interpretation are already done by the parser.
 */

import { htmlToLLMText } from '@/parsing/html.js';
import { formatTimestampForLLM } from '@/lib/et-date.js';
import type { Agent, AgentResult, AgentStep } from '@/agent/result.js';
import { createIntentTools, intentOnToolCall } from '../intent-tools.js';
import type { Signal } from '@/agent/schemas.js';
import type { TaskResult } from '@/agent/schemas.js';
import { createLogger } from '@/lib/logger.js';
import type {
  OrchestratorContext,
  OrchestratorResult,
  ParseResult,
  ResolvedSignal,
} from './types.js';
import { resolveOpenPath, resolveAddPath } from './open-path.js';
import { resolvePositionPath } from './position-path.js';
import { lookupIntent, writeIntent, INTENT_VERSION } from './intent-cache.js';
import type { IntentStep } from '@/db/schema.js';
import { canonicalizeSignals } from '@/eval/canonical-signal.js';
import { synthesizeDeterministicSignals } from './classifier-signals.js';

const log = createLogger('Orchestrator:LLM');

// ── Simplified NLU-only system prompt ─────────────────────────────────────────
//
// Direction rules, PCS normalization, badge handling, lotto/yolo overrides are
// all handled by the parser before this path is called. This prompt focuses
// purely on natural language understanding.

const NLU_SYSTEM_PROMPT = `You are a trading-signal classifier for an autonomous copy-trade system that mirrors a live options-trading chat room. Every message you classify either becomes a real broker order or is silently dropped. There is no human in the loop for routine decisions, so a wrong EXECUTE costs real money and a wrong SKIP misses a real trade.

<goal>
Read one chat message and decide: is the author announcing a trade they have placed (or are placing right now), and if so, what are the signals? Return the decision through the submit_decision tool.
</goal>

<audience>
You are the last safety net after a deterministic parser already handled every message that matched unambiguous structural patterns. Anything that reaches you is ambiguous by construction — slow down, read carefully, and when you cannot tell, SKIP.
</audience>

<tools>
- submit_decision(decision, reasoning, signals?) — REQUIRED exit. decision is one of EXECUTE | SKIP | MANUAL_REVIEW.
- get_recent_chat(author?, limit?) — fetch prior messages. Call this when the message references another trader ("following Dave", "@spectre same trade", "ty Hari") or is a bare "in" / "same" with no details.
- flag_for_review(reason) — only when you truly cannot decide and a human must review. Prefer SKIP over flag_for_review when the message is clearly not a trade; prefer flag_for_review only when you believe a trade IS present but something structural prevents you from describing it.
</tools>

<decision_rubric>
Walk through these checks in order. The FIRST one that matches wins.

1. Is this a FIRST-PERSON trade announcement by the author? If the buy/sell verb applies to a third party (Musk, Pelosi, insiders, "company X", another fund), SKIP. Only the author's own trades execute.
2. Is it CONDITIONAL or FUTURE-TENSE? "will", "going to", "looking to", "trying to", "hoping to", "plan to", "might", "thinking about", "if we test X", "would like to", "if I were to" → SKIP. A trade that has not happened is not a signal.
3. Is it ANALYSIS or MARKET QUOTE? "can be had for", "going for", "available at", "is priced at", "trading at", "would cost", "looks cheap at" → SKIP. Describing what the market shows is not a confirmed fill.
4. Is it SELF-REFLECTION or RULE-SETTING? "banning myself from day trades", "everything I enter will be a swing", "I always hold overnight" → SKIP, even if tickers are mentioned as examples.
5. Is it a HYPOTHETICAL or EDUCATIONAL example? "if I were looking to…", "you could sell the 220p for 1.0" → SKIP.
6. Is it EXPIRED-WORTHLESS commentary? "NVDA 170p expired worthless", "those calls went to zero" → SKIP. No broker action.
7. Is it a PAPER trade, FUTURES (ES, NQ, RTY, YM), or explicitly flagged as sim / demo? → SKIP.
8. Is it a FOLLOW-TRADE with no details ("@Dave same trade", "ty Hari", "in with you", "following")? Call get_recent_chat (optionally filtered by the referenced author), find the most recent trade they announced, and mirror it as the signal.
9. Otherwise: it IS a trade. Emit one or more signals and EXECUTE.
</decision_rubric>

<signal_fields>
Each signal in signals[] must match this shape. Omit fields you cannot determine — never invent values.

- action: one of OPEN | ADD | CLOSE | TRIM | LEG_OFF (required)
- symbol: uppercase ticker from the pre-parsed symbols list (required)
- direction: LONG | SHORT. REQUIRED for OPEN/ADD on STOCK, CALL, PUT. Optional hint on exits. NEVER emit null direction on an OPEN with strategy STOCK/CALL/PUT.
- strategy: STOCK | CALL | PUT | CDS | PDS | PCS | CCS. REQUIRED for OPEN. There is no STRANGLE strategy — a strangle or straddle becomes TWO signals (one CALL and one PUT).
- strikes: array of numbers explicitly stated in the message. [332.5] for a single, [190, 192.5] for a spread. Omit if not stated.
- expiry: expiry string as written ("Oct", "Nov 14", "next week", "0DTE", "5/23"). Omit if not stated.
- statedPrice: the dollar price the author fills at. MUST be strictly positive. If the only number you see is 0 or a stripped ".63", emit 0.63 or OMIT the field — never emit 0.
- quantity: shares or contracts when stated. "1,000 shares" → quantity=1000, NOT statedPrice.
- exitPercent: 0.0–1.0 for TRIM only. "half" → 0.5, "1/3" → 0.333, "25%" → 0.25, "75%" → 0.75.
- targetStrategy: for LEG_OFF only, the strategy the position BECOMES after removing a leg (the KEPT leg).

Direction semantics:
- STOCK/CALL/PUT: LONG = buying, SHORT = selling. "Short [ticker] calls" as a bullish view is still direction=LONG if the verb is "bought"; "sold" / "wrote" / "writing" is authoritative for SHORT. "Lotto" / "Yolo" ALWAYS means a speculative OPTIONS buy — NEVER emit strategy=STOCK when "lotto" or "yolo" appears. "Long X lotto" → strategy=CALL direction=LONG; "Short X lotto" → strategy=PUT direction=LONG (buying the put because the author's bias is bearish).
- CLOSE/TRIM direction from context: when a message references closing a prior position ("sold shares to lock in profits on my calls", "took profits on my long", "covered my short"), derive direction from the POSITION that existed, not the current verb. "sold shares … on my 210 GOOGL calls" means the author WAS long stock/calls — emit direction=LONG.
- CLOSE/TRIM direction from badges: [SHORT BADGE] + [EXIT BADGE] means closing a SHORT position → direction=SHORT. [LONG BADGE] + [EXIT BADGE] means closing a LONG position → direction=LONG. "Short Exit TSLA 328" → direction=SHORT. "Exit Long RBLX 132" → direction=LONG. Always emit direction on CLOSE/TRIM when badges unambiguously say so.
- CLOSE/TRIM statedPrice: extract the exit price from the message. "Exit UPS 82.08" → statedPrice=82.08. "Short Exit HOOD 98.89" → statedPrice=98.89. "Exit Short ETSY $51.30 for scratch" → statedPrice=51.30. The number immediately after or near the ticker on an exit IS the exit fill price — extract it. Only exclude numbers clearly in parenthetical P&L ("(51c gain)", "($1 profit)").
- Spreads: direction is bias-derived. CDS and PCS → direction=LONG (bullish). PDS and CCS → direction=SHORT (bearish). Do NOT try to derive spread direction from leg side — use these constants.
</signal_fields>

<rules>
1. Trust the pre-parsed \`Symbols detected\` list. Real tickers collide with English words: OPEN (Opendoor), SEE, M, C, V, Z, A, F, T, X, ALL, KEY, ON, LOW. If the symbols list contains one of these, that IS the ticker — do not reject the message as "no ticker". "Long OPEN at 8.50" with symbols=["OPEN"] is an OPEN LONG STOCK trade on Opendoor.
2. The English verb "put" ("put myself back in", "put on a hedge", "put together") is NOT the PUT option strategy. Strategy=PUT requires explicit option language ("puts", "185p", "put credit spread").
3. Numbers stuck to a ticker ARE the entry price, not part of the symbol. "Short RKLB 45.96" → symbol=RKLB, statedPrice=45.96. "Long NVO55" → symbol=NVO, statedPrice=55. "Short CVNA at 362" → statedPrice=362. Only exclude a number if it is obviously a quantity ("1,000 shares"), a P&L amount ("$2 profit"), a risk budget ("$500 risk"), or an alert threshold.
4. Exit badge language is a trade. [EXIT BADGE] + [LONG BADGE]/[SHORT BADGE] + ticker means the author closed a position. Emit CLOSE (or TRIM if a partial size is stated) even without an explicit price.
5. Entry verbs that ARE trades (past tense, present progressive, or bare entry): "bought", "shorted", "opened", "filled at", "in at", "entered", "added", "sold to open", "wrote", "long X at Y", "short X at Y", "bought back", "covered". "Bought back" and "covered" close a short → action=CLOSE on the short position.
6. Exit verbs that ARE trades (the exit happened or is happening right now): "closed", "took profits", "stopped out", "cut", "sold", "trimmed", "scaled out", "half out", "all out", "exiting now", "selling here". Future or intent-language ("will take gains", "looking to trim", "plan to close") is NOT an exit — SKIP.
7. Partial-exit sizing: "half out", "cut half", "50%" → TRIM, exitPercent=0.5. "1/3 off" → TRIM, exitPercent=0.333. "25% trim" → TRIM, exitPercent=0.25. "all out", "full exit", "closed", "stopped out" → CLOSE (no exitPercent).
8. LEG_OFF is used when the author removes ONE leg of a spread and keeps the other. "Legged off the 170p, keeping the calls" → action=LEG_OFF, targetStrategy=CALL (the kept leg). "Closed the put side of the spread" → action=LEG_OFF, targetStrategy=CALL.
9. Multi-trade messages decompose into one signal per distinct trade. "Long NVO 55 and Short BNS 63.52" → two signals. "Closed AAPL and opened TSLA 420c for 2.10" → two signals.
10. Strangles and straddles decompose into one CALL signal + one PUT signal. Both legs share direction=LONG when the author "bought" the combo. Do NOT emit strategy=STRANGLE; that value does not exist.
11. Badges override English adjectives. [LONG BADGE] ticker = bullish view; [SHORT BADGE] ticker = bearish view. But the verb is authoritative for direction: "[LONG BADGE] BE sold Oct $59 put" → direction=SHORT because the author SOLD. "[SHORT BADGE] FRPT" (bare, no verb) → direction=SHORT from the badge.
12. Message with badges + ticker + price and trailing personal commentary IS a trade. "[LONG BADGE] BE $54.73 and [LONG BADGE] BNS $63.52 — both swing trades, small size, acclimating to holding overnight" → two OPEN LONG STOCK signals. Do not SKIP because of commentary about style or philosophy.
13. If direction cannot be determined from badge, verb, or strategy (e.g. ambiguous multi-leg with missing leg info) and the message appears to be a real trade, call flag_for_review. Do not emit an OPEN with null direction on STOCK/CALL/PUT.
14. When in doubt, SKIP. A missed trade is recoverable; a false EXECUTE places a real order.
</rules>

<output_format>
Walk through the decision rubric in the \`reasoning\` argument of submit_decision. State which rubric step fired and why. Keep the reasoning under 300 characters — it must explain your call, not narrate the whole message.

Then set:
- decision = "EXECUTE" and populate signals[] (one per distinct trade), OR
- decision = "SKIP" with reasoning, OR
- decision = "MANUAL_REVIEW" (only when a trade is clearly present but unparseable).

Call submit_decision exactly once.
</output_format>

<examples>
<example>
<input>Text: "Short RKLB 45.96"  Badges: ["Short"]  Symbols: ["RKLB"]</input>
<decision>EXECUTE, reasoning="Rubric 9: bare entry, Short badge + ticker + price stuck to ticker." signals=[{action:"OPEN", symbol:"RKLB", strategy:"STOCK", direction:"SHORT", statedPrice:45.96}]</decision>
</example>

<example>
<input>Text: "Long NVO55 and Short BNS 63.52 - both swing"  Badges: ["Long","Short"]  Symbols: ["NVO","BNS"]</input>
<decision>EXECUTE, reasoning="Rubric 9 + Rule 9: two trades in one message, price stuck to ticker." signals=[{action:"OPEN",symbol:"NVO",strategy:"STOCK",direction:"LONG",statedPrice:55},{action:"OPEN",symbol:"BNS",strategy:"STOCK",direction:"SHORT",statedPrice:63.52}]</decision>
</example>

<example>
<input>Text: "Long OPEN at 8.50"  Badges: ["Long"]  Symbols: ["OPEN"]</input>
<decision>EXECUTE, reasoning="Rubric 9 + Rule 1: OPEN is Opendoor ticker from pre-parsed symbols, not an action word." signals=[{action:"OPEN",symbol:"OPEN",strategy:"STOCK",direction:"LONG",statedPrice:8.5}]</decision>
</example>

<example>
<input>Text: "Musk bought a billion dollars of TSLA stock"  Symbols: ["TSLA"]</input>
<decision>SKIP, reasoning="Rubric 1: buy verb applies to third party (Musk), not the author."</decision>
</example>

<example>
<input>Text: "AAPL PCS 220/215 expiring 10/3 can be had for 1.0"  Symbols: ["AAPL"]</input>
<decision>SKIP, reasoning="Rubric 3: 'can be had for' is a market-availability quote, not a confirmed fill."</decision>
</example>

<example>
<input>Text: "would like to add more size if we test 330"  Symbols: ["SPY"]</input>
<decision>SKIP, reasoning="Rubric 2: conditional 'would like... if' is future intent, not a trade."</decision>
</example>

<example>
<input>Text: "banning myself from day trades, everything I enter will be a swing. ABT is a good example today"  Symbols: ["ABT"]</input>
<decision>SKIP, reasoning="Rubric 4: self-rule commentary referencing ABT as an example, no execution."</decision>
</example>

<example>
<input>Text: "NVDA 170p expired worthless"  Symbols: ["NVDA"]</input>
<decision>SKIP, reasoning="Rubric 6: expired-worthless commentary, no broker action."</decision>
</example>

<example>
<input>Text: "half out of CRWV calls for +40%"  Badges: ["Exit","Long"]  Symbols: ["CRWV"]</input>
<decision>EXECUTE, reasoning="Rule 7: partial exit with 'half out' → TRIM 0.5 on the existing CALL." signals=[{action:"TRIM",symbol:"CRWV",strategy:"CALL",exitPercent:0.5}]</decision>
</example>

<example>
<input>Text: "legged off the 170p, keeping the calls"  Symbols: ["NVDA"]</input>
<decision>EXECUTE, reasoning="Rule 8: LEG_OFF, keeping calls → targetStrategy=CALL." signals=[{action:"LEG_OFF",symbol:"NVDA",targetStrategy:"CALL"}]</decision>
</example>

<example>
<input>Text: "[LONG BADGE] [SHORT BADGE] SPY strangle - bought $673 calls and $670 puts for 2.26 - 20 contracts"  Symbols: ["SPY"]</input>
<decision>EXECUTE, reasoning="Rule 10: strangle decomposes into CALL + PUT; 'bought' → LONG." signals=[{action:"OPEN",symbol:"SPY",strategy:"CALL",direction:"LONG",strikes:[673],statedPrice:2.26,quantity:20},{action:"OPEN",symbol:"SPY",strategy:"PUT",direction:"LONG",strikes:[670],statedPrice:2.26,quantity:20}]</decision>
</example>

<example>
<input>Text: "@Dave same trade" (after get_recent_chat shows Dave just posted "Long MSTR $362 calls for 4.20")</input>
<decision>EXECUTE, reasoning="Rubric 8 follow-trade: mirroring Dave's MSTR 362c long." signals=[{action:"OPEN",symbol:"MSTR",strategy:"CALL",direction:"LONG",strikes:[362],statedPrice:4.2}]</decision>
</example>

<example>
<input>Text: "bought back my AMZN short for a small profit"  Symbols: ["AMZN"]</input>
<decision>EXECUTE, reasoning="Rule 5: 'bought back' closes a short → CLOSE on the SHORT STOCK position." signals=[{action:"CLOSE",symbol:"AMZN",strategy:"STOCK",direction:"SHORT"}]</decision>
</example>

<example>
<input>Text: "put myself back in SPY at 485"  Symbols: ["SPY"]</input>
<decision>EXECUTE, reasoning="Rule 2: 'put' is verb not strategy; re-entry on SPY stock at 485." signals=[{action:"OPEN",symbol:"SPY",strategy:"STOCK",direction:"LONG",statedPrice:485}]</decision>
</example>

<example>
<input>Text: ".63 credit on the AAPL PCS 220/215 for Oct"  Symbols: ["AAPL"]</input>
<decision>EXECUTE, reasoning="Rubric 9: PCS credit spread filled at 0.63; direction=LONG (PCS is bullish)." signals=[{action:"OPEN",symbol:"AAPL",strategy:"PCS",direction:"LONG",strikes:[220,215],expiry:"Oct",statedPrice:0.63}]</decision>
</example>
</examples>

Now classify the message. Walk through the rubric, then call submit_decision.`;

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the LLM path for a message that requires natural language understanding.
 *
 * Routes each LLM-produced signal through the appropriate resolution path
 * (open-path for OPEN, position-path for CLOSE/TRIM/LEG_OFF).
 */
export async function resolveLLMPath(
  parse: ParseResult,
  ctx: OrchestratorContext,
  agent: Agent,
): Promise<OrchestratorResult> {
  const model = agent.identity.model;

  // ── Cache check (skip for 422 retries — failureContext alters the prompt) ──
  if (!ctx.failureContext) {
    const cached = lookupIntent(ctx.message.id, model);
    if (cached) {
      log.debug(
        `LLM cache hit for message ${ctx.message.id} (v${INTENT_VERSION}) → ` +
        `${describeCachedDecision(cached.decision, cached.signals, cached.reasoning)}`,
      );
      return resolveFromCached(cached.decision, cached.reasoning, cached.signals, parse, ctx);
    }
  }

  log.debug(`LLM cache miss for message ${ctx.message.id}, calling LLM`);

  const userPrompt = buildNLUPrompt(parse, ctx);

  const tools = createIntentTools(async (author, limit) => {
    return ctx.chatHistory.getRecentMessages(author, limit);
  });

  let agentResult: AgentResult;
  try {
    agentResult = await agent.run({
      systemPrompt: NLU_SYSTEM_PROMPT,
      userPrompt,
      tools,
      onToolCall: intentOnToolCall,
      maxTurns: 5,
    });
  } catch (err) {
    log.error('LLM path agent loop failed:', err);
    return {
      outcome: 'MANUAL_REVIEW',
      reason: `LLM error: ${err instanceof Error ? err.message : String(err)}`,
      classifierSignals: synthesizeDeterministicSignals(parse),
    };
  }

  const usage = agentResult.usage.inputTokens > 0
    ? { inputTokens: agentResult.usage.inputTokens, outputTokens: agentResult.usage.outputTokens }
    : undefined;
  const taskResult = agentResult.result as TaskResult | null;

  // ── Write to cache (fire-and-forget, INSERT OR IGNORE) ──
  writeIntent({
    messageId: ctx.message.id,
    model,
    route: 'llm',
    decision: taskResult?.decision ?? 'MANUAL_REVIEW',
    reasoning: taskResult?.reasoning ?? 'LLM did not call a decision tool',
    signals: taskResult?.signals ?? null,
    durationMs: agentResult.steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
    inputTokens: agentResult.usage.inputTokens,
    outputTokens: agentResult.usage.outputTokens,
    turns: agentResult.steps.filter(s => s.tool).length,
    steps: agentResult.steps as IntentStep[],
  });

  if (!taskResult) {
    const stepSummary = summarizeAgentSteps(agentResult.steps);
    log.warn(
      `LLM did not call a decision tool for message ${ctx.message.id} — ${stepSummary}`,
    );
    return { outcome: 'MANUAL_REVIEW', reason: 'LLM did not call a decision tool', usage, classifierSignals: [] };
  }

  // Canonicalize at the write boundary (expiry → ISO, strikes sorted, symbol uppercased)
  // so downstream equality comparisons don't need normalization.
  // Also back-fill direction/strategy from the deterministic parse when LLM drops them.
  const rawSignals: Signal[] = canonicalizeSignals(taskResult.signals ?? []).map((s) => {
    const next = { ...s };
    if (next.direction == null && parse.direction != null && parse.symbol === next.symbol) {
      next.direction = parse.direction;
    }
    if (next.strategy == null && parse.strategy != null && parse.symbol === next.symbol) {
      next.strategy = parse.strategy;
    }
    return next;
  });

  if (taskResult.decision === 'SKIP') {
    return { outcome: 'SKIP', reason: taskResult.reasoning, usage, classifierSignals: rawSignals };
  }

  if (taskResult.decision === 'MANUAL_REVIEW') {
    return { outcome: 'MANUAL_REVIEW', reason: taskResult.reasoning, usage, classifierSignals: rawSignals };
  }

  if (rawSignals.length === 0) {
    return { outcome: 'MANUAL_REVIEW', reason: 'LLM returned EXECUTE with no signals', usage, classifierSignals: rawSignals };
  }

  log.debug(
    `LLM path: ${rawSignals.length} signal(s) for message ${ctx.message.id} — ` +
    `${describeSignals(rawSignals)} | reasoning: ${truncate(taskResult.reasoning, 200)}`,
  );

  // Route each signal through the appropriate resolution path
  const result = await routeLLMSignals(rawSignals, parse, ctx);
  return { ...result, usage, llmReasoning: taskResult.reasoning, classifierSignals: rawSignals };
}

/** Reconstruct an OrchestratorResult from a cached intent (zero token usage). */
async function resolveFromCached(
  decision: string,
  reasoning: string | null,
  signals: Signal[] | null,
  parse: ParseResult,
  ctx: OrchestratorContext,
): Promise<OrchestratorResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const rawSignals: Signal[] = canonicalizeSignals(signals ?? []);

  if (decision === 'SKIP') {
    return { outcome: 'SKIP', reason: reasoning ?? 'cached skip', usage, classifierSignals: rawSignals };
  }
  if (decision === 'MANUAL_REVIEW') {
    return { outcome: 'MANUAL_REVIEW', reason: reasoning ?? 'cached manual review', usage, classifierSignals: rawSignals };
  }
  if (rawSignals.length === 0) {
    return { outcome: 'MANUAL_REVIEW', reason: 'cached EXECUTE with no signals', usage, classifierSignals: rawSignals };
  }

  const result = await routeLLMSignals(rawSignals, parse, ctx);
  return { ...result, usage, llmReasoning: reasoning ?? undefined, classifierSignals: rawSignals };
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildNLUPrompt(parse: ParseResult, ctx: OrchestratorContext): string {
  const messageText = htmlToLLMText(ctx.message.rawHtml);
  const dateStr = formatTimestampForLLM(ctx.message.timestamp);

  const lines: string[] = [
    `Classify this trading message.`,
    ``,
    `Date/Time: ${dateStr}`,
    `Author: ${ctx.message.author}`,
    `Badges: ${JSON.stringify(ctx.message.badges)}`,
    `Text: ${messageText}`,
    `Symbols detected: ${JSON.stringify(ctx.message.symbols)}`,
  ];

  // Include what the parser already determined — LLM doesn't need to re-derive these.
  // For multi_ticker messages, ALL per-symbol fields (action, strategy, direction,
  // strikes, expiry, premium) come from the merged full text and reflect only the first
  // symbol. Sending them anchors the LLM to a single signal, suppressing multi-trade
  // decomposition. Suppress everything; let the LLM derive per-signal fields from text.
  const isMultiTicker = parse.complexityFlags.has('multi_ticker');
  const knownParts: string[] = [];
  if (!isMultiTicker && parse.action) knownParts.push(`action=${parse.action}`);
  if (!isMultiTicker && parse.strategy) knownParts.push(`strategy=${parse.strategy}`);
  if (!isMultiTicker && parse.direction) knownParts.push(`direction=${parse.direction}`);
  if (!isMultiTicker && parse.strikes?.length) knownParts.push(`strikes=${parse.strikes.join('/')}`);
  if (!isMultiTicker && parse.expiryHint) knownParts.push(`expiryHint="${parse.expiryHint}"`);
  if (!isMultiTicker && parse.premiumHint !== null) knownParts.push(`premium=$${parse.premiumHint}`);

  if (knownParts.length > 0) {
    lines.push(``, `Pre-parsed fields: ${knownParts.join(', ')}`);
  }

  if (parse.complexityFlags.size > 0) {
    lines.push(`Complexity: ${Array.from(parse.complexityFlags).join(', ')}`);
  }

  if (ctx.failureContext) {
    lines.push(
      ``,
      `⚠️ Previous execution attempt failed: ${ctx.failureContext.error}`,
      `This usually means a strike was misread from the message (e.g. "$342/5" typed instead of "$342.5", or a typo).`,
      `Re-examine the original message text and provide corrected strike(s).`,
    );
  }

  lines.push(``, `Classify and call submit_decision.`);
  return lines.join('\n');
}

// ── Signal routing ────────────────────────────────────────────────────────────

/**
 * Convert LLM Signal[] into ParseResults and route each through
 * the appropriate resolution path (open-path or position-path).
 */
async function routeLLMSignals(
  llmSignals: Signal[],
  originalParse: ParseResult,
  ctx: OrchestratorContext,
): Promise<OrchestratorResult> {
  const allSignals: ResolvedSignal[] = [];
  const flagReasons: string[] = [];

  for (const signal of llmSignals) {
    const signalParse = signalToParseResult(signal, originalParse);
    let result: OrchestratorResult;

    // Safety net: reroute STOCK OPEN→ADD when a matching position already exists.
    // The LLM may output OPEN for "added more shares" if it doesn't use ADD.
    if (signalParse.action === 'OPEN' && signalParse.strategy === 'STOCK' && signalParse.symbol) {
      const existing = await ctx.positions.getPositions(signalParse.symbol);
      const dup = existing.find(p => p.strategy === 'STOCK' && p.direction === signalParse.direction);
      if (dup) {
        signalParse.action = 'ADD';
      }
    }

    if (signalParse.action === 'ADD') {
      result = await resolveAddPath(signalParse, ctx);
    } else if (signalParse.action === 'OPEN') {
      result = await resolveOpenPath(signalParse, ctx);
    } else if (
      signalParse.action === 'CLOSE' ||
      signalParse.action === 'TRIM' ||
      signalParse.action === 'LEG_OFF'
    ) {
      result = await resolvePositionPath(signalParse, ctx);
    } else {
      flagReasons.push(`unroutable action from LLM: ${signalParse.action ?? 'null'}`);
      continue;
    }

    if (result.outcome === 'EXECUTE') {
      allSignals.push(...result.signals);
    } else if (result.outcome === 'MANUAL_REVIEW') {
      flagReasons.push(result.reason);
    }
    // SKIP from a sub-signal is treated as no output (not propagated as top-level SKIP)
  }

  if (allSignals.length > 0) {
    return { outcome: 'EXECUTE', signals: allSignals };
  }

  return {
    outcome: 'MANUAL_REVIEW',
    reason:
      flagReasons.length > 0
        ? flagReasons.join('; ')
        : 'LLM path produced no executable signals',
  };
}

/**
 * Convert an LLM-produced Signal to a ParseResult for resolution routing.
 * Merges with the original parser output (parser is authoritative for fields
 * it could determine; LLM fills in what was null).
 */
function signalToParseResult(signal: Signal, originalParse: ParseResult): ParseResult {
  // Extract strikes from signal (filter zeros — hint values)
  const llmStrikes =
    signal.strikes
      ?.filter((s) => s > 0) ?? null;

  // Extract expiry hint from signal
  const llmExpiryHint = signal.expiry ?? null;

  return {
    action: signal.action,
    symbol: signal.symbol,
    direction: signal.direction ?? originalParse.direction,
    strategy: signal.strategy as ParseResult['strategy'],
    strikes: llmStrikes?.length ? llmStrikes : originalParse.strikes,
    expiryHint: llmExpiryHint ?? originalParse.expiryHint,
    premiumHint: signal.statedPrice != null ? Number(signal.statedPrice) : originalParse.premiumHint,
    exitPercent: signal.exitPercent ?? originalParse.exitPercent,
    targetStrategy: originalParse.targetStrategy ??
      (signal.targetStrategy as ParseResult['targetStrategy']),
    isLotto: originalParse.isLotto,
    isStrangle: false,
    isHardSkip: false,
    skipReason: null,
    complexityFlags: new Set(), // LLM-resolved signals have no complexity flags
  };
}

// ── Logging helpers ───────────────────────────────────────────────────────────

function describeSignals(signals: Signal[]): string {
  return signals
    .map((s) => {
      const head = [s.action, s.strategy, s.symbol].filter(Boolean).join(' ');
      const dir = s.direction ? ` ${s.direction}` : '';
      const strikes = s.strikes && s.strikes.length ? ` ${s.strikes.join('/')}` : '';
      const expiry = s.expiry ? ` exp=${s.expiry}` : '';
      const price = s.statedPrice != null ? ` $${s.statedPrice}` : '';
      return `${head}${dir}${strikes}${expiry}${price}`;
    })
    .join(' | ');
}

function describeCachedDecision(
  decision: string,
  signals: Signal[] | null,
  reasoning: string | null,
): string {
  if (decision === 'EXECUTE' && signals && signals.length > 0) {
    return `EXECUTE ${signals.length} signal(s) [${describeSignals(signals)}]`;
  }
  const r = reasoning ? ` reasoning="${truncate(reasoning, 120)}"` : '';
  return `${decision}${r}`;
}

function summarizeAgentSteps(steps: AgentStep[]): string {
  const toolCalls = steps.filter((s) => s.tool);
  const textSteps = steps.filter((s) => !s.tool && s.reasoning);
  const parts: string[] = [
    `${steps.length} step(s)`,
    `${toolCalls.length} tool call(s)`,
    `${textSteps.length} text step(s)`,
  ];
  if (toolCalls.length > 0) {
    const toolNames = toolCalls.map((s) => s.tool).join(',');
    parts.push(`tools=[${toolNames}]`);
  }
  if (textSteps.length > 0) {
    const lastText = textSteps[textSteps.length - 1].reasoning ?? '';
    parts.push(`lastText="${truncate(lastText, 200)}"`);
  }
  return parts.join(' ');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

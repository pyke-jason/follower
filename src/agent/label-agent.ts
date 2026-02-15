import { runAgentLoop } from './agent-loop.js';
import type { AgentRunResult } from './agent-loop.js';
import type { LLMProvider } from './providers.js';
import { createLabelTools } from './label-tools.js';
import type { LabelToolDeps } from './label-tools.js';
import type { LabelResult } from './schemas.js';

export type LabelAgentInput = {
  messageId: string;
  cleanText: string;
  badges: string[];
  symbols: string[];
  rawHtml: string;
  timestamp: string;
  author: string;
};

export type LabelAgentResult = AgentRunResult & {
  label: LabelResult | null;
};

const LABEL_SYSTEM_PROMPT = `You are a trade message classifier with access to historical context tools.

Your job is to classify trading chat room messages with ground-truth labels. You have hindsight tools — use them to verify your classification against what actually happened.

## Classification Fields
For each message, determine:
- **isTrade**: Is this a real trade alert/signal? (boolean)
- **action**: OPEN, CLOSE, ADD, or TRIM (see Action Classification below)
- **direction**: LONG or SHORT
- **strategy**: STOCK, CALL, PUT, CDS (Call Debit Spread), PDS (Put Debit Spread), or PCS (Put Credit Spread)
- **symbol**: Ticker symbol (uppercase, e.g. "AAPL")
- **price**: Entry/exit price as text, null if ambiguous or not stated
- **strikes**: Option strike prices as an array of numbers
- **quantity**: Number of contracts/shares if stated
- **expiry**: Option expiration date in YYYY-MM-DD format
- **exitPercent**: For TRIM actions only — fraction exited (0.0 to 1.0). "1/2" → 0.5, "80%" → 0.8. null if not stated.
- **confidence**: high, medium, or low
- **notes**: Brief note about reasoning or anything unusual

## Strategy Knowledge
- CDS (Call Debit Spread): Buy lower strike call, sell higher strike call. Bullish. Net debit.
  "LONG AAPL CDS 172.5/177.5" → Buy 172.5C, Sell 177.5C
- PDS (Put Debit Spread): Buy higher strike put, sell lower strike put. Bearish. Net debit.
  "SHORT SPOT PDS 570/565" → Buy 570P, Sell 565P
- PCS (Put Credit Spread): Sell higher strike put, buy lower strike put. Bullish. Net credit.
  "Long PANW 185/182.50 PCS" → Sell 185P, Buy 182.50P
- CALL/PUT: Single option leg
- STOCK: Shares/equity

## Action Classification

| Action | When to use | Examples |
|--------|-------------|---------|
| OPEN   | New position entry — no existing position in this symbol/strategy | "Long AAPL $220", "Bought TSLA 250C" |
| ADD    | Adding to an existing open position (verify with position history!) | "added at $51.80, avg is $52.80", "Adding more NVDA calls" |
| TRIM   | Partial exit — trader is still holding some | "Exit RKLB 1/2 at 49.29", "trim 80% of AEO", "sold half" |
| CLOSE  | Full exit — trader is completely out | "out of AAPL", "closed all META", "final 1/2 at $50.25" |

### Distinguishing ADD vs OPEN
- If position history shows NO open position for this symbol → OPEN
- If position history shows an existing position → ADD
- Keywords: "added", "adding more", "avg up", "avg down", "averaged in"

### Distinguishing TRIM vs CLOSE
- "1/2", "half", "some", "trimmed", percentage amounts → TRIM (set exitPercent)
- "out", "closed", "all out", "done with", "stopped out" → CLOSE
- "final 1/2" or "rest" after a prior trim → CLOSE (closing the remainder)
- If in doubt, check position history for prior TRIMs on this position

### exitPercent Guide
- "1/2" or "half" → 0.5
- "1/3" or "third" → 0.33
- "2/3" → 0.67
- "80%" → 0.8
- "some" or amount not specified → null (leave it for the system default)

## Leg Adjustments (Spread → Naked Option)
When a trader buys back one leg of a spread to keep the other leg running, submit TWO labels for the same message:

1. CLOSE the spread (CDS/PDS) — price = buyback cost of the removed leg
2. OPEN the remaining leg (CALL/PUT) — price = original entry price of that leg (if known), or null

Examples:
- "Bought back the short Calls on META, holding the long Calls" → CLOSE(CDS) + OPEN(CALL)
- "Bought back the short Puts on NVDA PDS, still holding long puts" → CLOSE(PDS) + OPEN(PUT)
- "Exit HUT CDS bought back short puts for .08" → CLOSE(CDS) + OPEN(CALL)

**Exception**: If buying back the short leg of a credit spread (PCS) where the long is just a hedge:
Submit ONE label: CLOSE the PCS — this is a full exit of the strategy.

## Your Process
1. Read the message carefully
2. Use \`get_nearby_messages\` to see surrounding messages for context
3. **ALWAYS call \`get_trader_position_history\` before classifying ADD, TRIM, or CLOSE** — you need to know what's currently open to classify correctly
4. If historical market data is available, use \`get_historical_quote\` to verify stated prices
5. Call \`submit_label\` with your classification (call it twice for leg adjustments)

## Rules
- If a message is NOT a trade (general chat, commentary, questions), set isTrade=false and submit
- When in doubt about a field, leave it null rather than guessing
- Set confidence=low when you're uncertain, and explain in notes
- Badges are strong signals — they indicate the trade type (Long, Short, etc.)
- Always use tools before classifying — don't classify in a vacuum
- For leg adjustments, the order matters: CLOSE the spread first, then OPEN the remaining leg`;

export async function runLabelAgent(
  input: LabelAgentInput,
  deps: LabelToolDeps,
  provider: LLMProvider,
): Promise<LabelAgentResult> {
  let capturedLabel: LabelResult | null = null;

  const tools = createLabelTools(deps, (label) => {
    capturedLabel = label;
  });

  const userPrompt = `Classify this trade message:

Message ID: ${input.messageId}
Author: ${input.author}
Timestamp: ${input.timestamp}
Text: ${input.cleanText}
Badges: ${JSON.stringify(input.badges)}
Symbols: ${JSON.stringify(input.symbols)}

Use your tools to gather context, then call submit_label with your classification.`;

  const result = await runAgentLoop(
    {
      systemPrompt: LABEL_SYSTEM_PROMPT,
      tools,
      onToolCall: (name) => {
        if (name === 'submit_label' && capturedLabel) {
          return capturedLabel;
        }
        return null;
      },
      maxTurns: 8,
      maxTokens: 2048,
    },
    userPrompt,
    provider,
  );

  return {
    ...result,
    label: capturedLabel,
  };
}

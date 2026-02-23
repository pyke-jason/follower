# Signal Redesign — Architecture Diagrams

**Context**: Redesigning the signal taxonomy so the LLM outputs 4 intents (OPEN/CLOSE/TRIM/LEG_OFF) with direction+strategy only required on OPEN. A normalizer maps LLM output to the existing 5 internal actions (OPEN/CLOSE/ADD/TRIM/LEG_OFF).

---

## 1. Current vs Proposed Signal Flow

### Current Flow

```mermaid
flowchart TD
    MSG[Chat Message] --> EI[extractIntent\nextract-intent.ts]
    EI --> |"AgentDecision{signals: Signal[]}"| CACHE[(messageIntents DB)]
    CACHE --> RUNNER[runner.ts Phase 2]
    RUNNER --> TA[RuleBasedTradeAgent\ntrade-agent.ts]

    subgraph Signal_Current ["Signal — 5 actions, all required fields"]
        S1["action: OPEN|CLOSE|ADD|TRIM|LEG_OFF\nsymbol: string\ndirection: LONG|SHORT  ← ALWAYS required\nstrategy: STOCK|CALL|PUT|CDS|PDS  ← ALWAYS required\nlegs?: SignalLeg[]\nexitPercent?: number\ntargetStrategy?: Strategy\nstatedPremium?: number"]
    end

    TA --> |"Action: PLACE_ORDER"| PIPELINE[executeSignal\nexecute.ts]

    subgraph Executor ["executeSignal — 5 branches"]
        E1[executeOpen]
        E2[executeClose]
        E3[executeAdd]
        E4[executeTrim]
        E5[executeLegOff]
    end

    PIPELINE --> E1 & E2 & E3 & E4 & E5
    E1 & E2 & E3 & E4 & E5 --> RT[recordTrade\nrecord-trade.ts]
    RT --> DB[(trades + trade_events DB)]
```

### Proposed Flow

```mermaid
flowchart TD
    MSG[Chat Message] --> EI[extractIntent\nextract-intent.ts]
    EI --> |"LLMSignal — 4 intents"| CACHE[(messageIntents DB)]
    CACHE --> RUNNER[runner.ts Phase 2]
    RUNNER --> NORM[normalizeSignal\nnormalizer.ts  ← NEW]

    subgraph LLMSignal_Proposed ["LLMSignal — 4 intents, minimal required fields"]
        LS1["intent: OPEN|CLOSE|TRIM|LEG_OFF\nsymbol: string\ndirection?: LONG|SHORT  ← only on OPEN\nstrategy?: STOCK|CALL|PUT|CDS|PDS  ← only on OPEN\nlegs?: SignalLeg[]\nexitPercent?: number\ntargetStrategy?: Strategy\nstatedPremium?: number"]
    end

    NORM --> |"InternalSignal — 5 actions"| TA[RuleBasedTradeAgent\ntrade-agent.ts]

    subgraph InternalSignal_Proposed ["InternalSignal — unchanged from current Signal"]
        IS1["action: OPEN|CLOSE|ADD|TRIM|LEG_OFF\nsymbol: string\ndirection: LONG|SHORT  ← always set by normalizer\nstrategy: STOCK|CALL|PUT|CDS|PDS  ← always set by normalizer\nlegs?: SignalLeg[]\nexitPercent?: number\ntargetStrategy?: Strategy\nstatedPremium?: number"]
    end

    TA --> |"Action: PLACE_ORDER"| PIPELINE[executeSignal\nexecute.ts]

    subgraph Executor_Proposed ["executeSignal — unchanged, 5 branches"]
        E1[executeOpen]
        E2[executeClose]
        E3[executeAdd]
        E4[executeTrim]
        E5[executeLegOff]
    end

    PIPELINE --> E1 & E2 & E3 & E4 & E5
    E1 & E2 & E3 & E4 & E5 --> RT[recordTrade\nrecord-trade.ts]
    RT --> DB[(trades + trade_events DB)]
```

**Key difference**: The normalizer sits between the cached intent and the trade agent. It maps LLM OPEN without position → OPEN, LLM OPEN with position → ADD, and enriches CLOSE/TRIM/LEG_OFF with direction+strategy from the existing DB position.

---

## 2. Type Transformation Chain

```mermaid
flowchart LR
    subgraph LLM_Output ["LLM Output (proposed)"]
        LS["LLMSignal\n─────────────\nintent: 4 values\nsymbol: string\ndirection? (OPEN only)\nstrategy? (OPEN only)\nlegs?\nexitPercent?\ntargetStrategy?\nstatedPremium?"]
    end

    subgraph Normalizer ["normalizeSignal()  ← NEW"]
        N1{"intent =\nOPEN?"}
        N2{"position\nexists?"}
        N3{"intent =\nCLOSE/TRIM/\nLEG_OFF?"}
        N4[Look up open\nposition from DB\nfor direction+strategy]
        N5["Map intent → action\nCOPY direction+strategy\nfrom signal"]
        N6["Map OPEN → ADD\n(has existing pos)"]
        N7["Copy direction+strategy\nfrom existing position"]
    end

    subgraph Internal ["InternalSignal (= current Signal)"]
        IS["Signal\n─────────────\naction: 5 values\nsymbol: string\ndirection: LONG|SHORT  ← always present\nstrategy: Strategy  ← always present\nlegs?\nexitPercent?\ntargetStrategy?\nstatedPremium?"]
    end

    subgraph Pipeline ["execute.ts"]
        RT_IN["RecordTradeInput\n─────────────\naction: 5 values\nsymbol, trader\ndirection, strategy\nentryPrice / exitPrice\nquantity / closeQuantity\nlegs, openedAt, closedAt\nsourceMessageId\ncloseMessageId\ntaskId, backtestRunId\nisBacktest, metadata"]
    end

    subgraph DB_Layer ["DB Layer"]
        TRADE["Trade (trades table)\n─────────────\nid, symbol, trader\ndirection, strategy\nstatus: OPEN|CLOSED\nentryPrice, exitPrice\nquantity, pnl\nopenedAt, closedAt\nsourceMessageId\ncloseMessageId\nlegs (JSON)\nmetadata (JSON)"]
    end

    LS --> N1
    N1 -->|"yes"| N2
    N2 -->|"no position"| N5
    N2 -->|"has position"| N6
    N1 -->|"no"| N3
    N3 -->|"yes"| N4
    N4 --> N7
    N5 --> IS
    N6 --> IS
    N7 --> IS
    IS --> RT_IN
    RT_IN --> TRADE
```

### Field presence by action

| Field | LLMSignal OPEN | LLMSignal CLOSE/TRIM/LEG_OFF | InternalSignal (all) | RecordTradeInput |
|---|---|---|---|---|
| `action/intent` | `intent: OPEN` | `intent: CLOSE/TRIM/LEG_OFF` | `action: OPEN/CLOSE/ADD/TRIM/LEG_OFF` | `action` (same 5) |
| `symbol` | required | required | required | required |
| `direction` | required | omitted | required (set by normalizer) | required for OPEN/ADD, copied from position for CLOSE/TRIM/LEG_OFF |
| `strategy` | required | omitted | required (set by normalizer) | required for OPEN/ADD, copied from position for CLOSE/TRIM/LEG_OFF |
| `legs` | optional (explicit strikes) | omitted | optional | optional (pipeline infers if absent) |
| `exitPercent` | N/A | TRIM only | TRIM only | TRIM only |
| `targetStrategy` | N/A | LEG_OFF only | LEG_OFF only | LEG_OFF via metadata |
| `statedPremium` | optional | omitted | optional | not forwarded (informational) |

---

## 3. Sequence Diagrams — 4 LLM Intents

### 3a. OPEN Intent → executeOpen

```mermaid
sequenceDiagram
    participant LLM as extractIntent (LLM)
    participant Cache as messageIntents DB
    participant Runner as runner.ts
    participant Norm as normalizeSignal (NEW)
    participant Agent as RuleBasedTradeAgent
    participant Pipe as executeSignal
    participant Broker as SimBroker
    participant DB as trades DB

    LLM->>Cache: persist LLMSignal{intent:OPEN, direction, strategy, legs?}
    Runner->>Cache: fetch cached intent
    Cache-->>Runner: LLMSignal
    Runner->>Norm: normalizeSignal(llmSignal, trader, getOpenPositions)
    Norm->>DB: getOpenPositions(symbol, trader, strategy)
    DB-->>Norm: [] (no existing position)
    Norm-->>Runner: InternalSignal{action:OPEN, direction, strategy, ...}
    Runner->>Agent: onSignal(signal, trader, ctx, prefetched)
    Agent->>Agent: shouldSkipDeterministic()
    Agent->>Agent: shouldSkipSignal()
    Agent->>Agent: checkRiskLimits(OPEN)
    Agent->>Agent: calculateSize()
    Agent-->>Runner: Action{type:PLACE_ORDER, signal}
    Runner->>Pipe: executeSignal(signal, trader, deps, opts)
    Pipe->>Pipe: resolveSignalLegs()
    Pipe->>Broker: getQuote(symbol)
    Broker-->>Pipe: Quote
    Pipe->>Pipe: calculatePositionSize()
    Pipe->>Pipe: checkRiskLimits()
    Pipe->>Broker: placeOrder(params)
    Broker-->>Pipe: OrderResult{status:FILLED, filledPrice}
    Pipe->>DB: recordTrade{action:OPEN, entryPrice, ...}
    DB-->>Pipe: RecordTradeResult{tradeId}
    Pipe-->>Runner: PipelineResult{executed:true, tradeId}
```

### 3b. CLOSE Intent → executeClose (or ADD if position exists for OPEN)

```mermaid
sequenceDiagram
    participant LLM as extractIntent (LLM)
    participant Cache as messageIntents DB
    participant Runner as runner.ts
    participant Norm as normalizeSignal (NEW)
    participant Agent as RuleBasedTradeAgent
    participant Pipe as executeSignal
    participant Broker as SimBroker
    participant DB as trades DB

    LLM->>Cache: persist LLMSignal{intent:CLOSE, symbol}
    Runner->>Cache: fetch cached intent
    Cache-->>Runner: LLMSignal{intent:CLOSE, symbol}
    Runner->>Norm: normalizeSignal(llmSignal, trader, getOpenPositions)
    Norm->>DB: getOpenPositions(symbol, trader)
    DB-->>Norm: [Trade{direction:LONG, strategy:PUT}]
    Note over Norm: Enrich signal with position's direction+strategy
    Norm-->>Runner: InternalSignal{action:CLOSE, direction:LONG, strategy:PUT}
    Runner->>Agent: onSignal(signal, trader, ctx, prefetched)
    Agent->>Agent: shouldSkipDeterministic()
    Agent-->>Runner: Action{type:PLACE_ORDER, signal}
    Runner->>Pipe: executeSignal(signal, trader, deps, opts)
    Pipe->>DB: findPosition(symbol, trader, strategy)
    DB-->>Pipe: Trade (existing position)
    Pipe->>Pipe: buildOrder (reverse direction)
    Pipe->>Broker: getSpreadMidpoint()
    Broker-->>Pipe: mid price
    Pipe->>Broker: placeOrder(closeParams)
    Broker-->>Pipe: OrderResult{status:FILLED, filledPrice}
    Pipe->>DB: recordTrade{action:CLOSE, exitPrice, closeMessageId}
    DB-->>Pipe: RecordTradeResult{tradeId}
    Pipe-->>Runner: PipelineResult{executed:true, tradeId}
```

### 3c. TRIM Intent → executeTrim

```mermaid
sequenceDiagram
    participant LLM as extractIntent (LLM)
    participant Cache as messageIntents DB
    participant Runner as runner.ts
    participant Norm as normalizeSignal (NEW)
    participant Agent as RuleBasedTradeAgent
    participant Pipe as executeSignal
    participant Broker as SimBroker
    participant DB as trades DB

    LLM->>Cache: persist LLMSignal{intent:TRIM, symbol, exitPercent:0.5}
    Runner->>Cache: fetch cached intent
    Cache-->>Runner: LLMSignal
    Runner->>Norm: normalizeSignal(llmSignal, trader, getOpenPositions)
    Norm->>DB: getOpenPositions(symbol, trader)
    DB-->>Norm: [Trade{direction:LONG, strategy:CDS}]
    Norm-->>Runner: InternalSignal{action:TRIM, direction:LONG, strategy:CDS, exitPercent:0.5}
    Runner->>Agent: onSignal(signal, trader, ctx, prefetched)
    Agent-->>Runner: Action{type:PLACE_ORDER, signal}
    Runner->>Pipe: executeSignal(signal, trader, deps, opts)
    Pipe->>DB: findPosition(symbol, trader, strategy)
    DB-->>Pipe: Trade (existing position)
    Pipe->>Pipe: compute trimQty = floor(currentQty * exitPercent)
    Pipe->>Broker: placeOrder(trimParams, isClosing:true)
    Broker-->>Pipe: OrderResult{status:FILLED, filledPrice}
    Pipe->>DB: recordTrade{action:TRIM, closeQuantity, exitPercent, closeMessageId}
    DB-->>Pipe: RecordTradeResult{tradeId}
    Pipe-->>Runner: PipelineResult{executed:true, tradeId}
```

### 3d. LEG_OFF Intent → executeLegOff

```mermaid
sequenceDiagram
    participant LLM as extractIntent (LLM)
    participant Cache as messageIntents DB
    participant Runner as runner.ts
    participant Norm as normalizeSignal (NEW)
    participant Agent as RuleBasedTradeAgent
    participant Pipe as executeSignal
    participant Broker as SimBroker
    participant DB as trades DB

    LLM->>Cache: persist LLMSignal{intent:LEG_OFF, symbol, targetStrategy:CALL}
    Runner->>Cache: fetch cached intent
    Cache-->>Runner: LLMSignal
    Runner->>Norm: normalizeSignal(llmSignal, trader, getOpenPositions)
    Norm->>DB: getOpenPositions(symbol, trader)
    DB-->>Norm: [Trade{direction:LONG, strategy:CDS}]
    Norm-->>Runner: InternalSignal{action:LEG_OFF, direction:LONG, strategy:CDS, targetStrategy:CALL}
    Runner->>Agent: onSignal(signal, trader, ctx, prefetched)
    Agent-->>Runner: Action{type:PLACE_ORDER, signal}
    Runner->>Pipe: executeSignal(signal, trader, deps, opts)
    Pipe->>DB: findPosition(symbol, trader, strategy)
    DB-->>Pipe: Trade (existing CDS position)
    Pipe->>Pipe: identify SELL leg (the leg to close)
    Pipe->>Broker: placeOrder(buyback SELL leg)
    Broker-->>Pipe: OrderResult{status:FILLED, filledPrice}
    Pipe->>DB: recordTrade{action:LEG_OFF, strategy:CDS→CALL, keptLeg, closedLeg}
    DB-->>Pipe: RecordTradeResult{tradeId}
    Note over DB: Trade row mutated: strategy=CALL, legs=[keptLeg]
    Pipe-->>Runner: PipelineResult{executed:true, tradeId}
```

---

## 4. Data Flow — Fields Set/Read/Ignored at Each Stage

```mermaid
flowchart TD
    subgraph LLM_Stage ["Stage 1: LLM (extract-intent.ts)"]
        LLM_SET["SETS:\n• intent (4 values)\n• symbol\n• direction (OPEN only)\n• strategy (OPEN only)\n• legs (if trader stated strikes)\n• exitPercent (TRIM only)\n• targetStrategy (LEG_OFF only)\n• statedPremium (optional)"]
        LLM_IGNORE["IGNORES:\n• quantity (pipeline sizes)\n• prices (pipeline prices)\n• tradeId (unknown at parse time)"]
    end

    subgraph Norm_Stage ["Stage 2: normalizeSignal (NEW — normalizer.ts)"]
        NORM_SET["SETS:\n• action (maps intent → OPEN/CLOSE/ADD/TRIM/LEG_OFF)\n• direction (CLOSE/TRIM/LEG_OFF: copied from DB position)\n• strategy (CLOSE/TRIM/LEG_OFF: copied from DB position)"]
        NORM_READ["READS:\n• intent, symbol, trader\n• existing open position (DB query)"]
        NORM_PASSTHROUGH["PASSES THROUGH:\n• symbol, legs, exitPercent\n• targetStrategy, statedPremium"]
    end

    subgraph Agent_Stage ["Stage 3: RuleBasedTradeAgent (trade-agent.ts)"]
        AGENT_READ["READS:\n• action (OPEN/ADD → risk + sizing)\n• strategy (strategy gate)\n• symbol (risk check)\n• statedPremium (position sizing estimate)\n• legs (has legs? → can pre-size)"]
        AGENT_SET["SETS:\n• quantity (pre-sizing estimate)\n• order.legs (buildOrderFromSignal)"]
        AGENT_IGNORE["IGNORES:\n• exitPercent (pipeline computes trimQty)\n• targetStrategy (pipeline handles LEG_OFF)"]
    end

    subgraph Pipeline_Stage ["Stage 4: executeSignal (execute.ts)"]
        PIPE_READ["READS (all fields):\n• action → routes to executor\n• symbol, direction, strategy\n• legs (or infers via resolveSignalLegs)\n• exitPercent → trimQty calculation\n• targetStrategy → legToClose lookup"]
        PIPE_SET["SETS (RecordTradeInput):\n• entryPrice / exitPrice (from broker fill)\n• quantity (from sizer)\n• openedAt / closedAt (fill timestamp)\n• sourceMessageId (OPEN/ADD)\n• closeMessageId (CLOSE/TRIM/LEG_OFF)\n• backtestRunId, isBacktest\n• metadata (LEG_OFF: keptLeg, closedLeg)"]
        PIPE_IGNORE["IGNORES:\n• statedPremium (informational only)\n• LLM intent field (already mapped to action)"]
    end

    subgraph RecordTrade_Stage ["Stage 5: recordTrade (record-trade.ts)"]
        RT_READ["READS:\n• action → INSERT/UPDATE branch\n• tradeId → fast path vs scope query\n• direction, strategy, quantity\n• entryPrice, exitPrice\n• openedAt, closedAt\n• sourceMessageId, closeMessageId\n• backtestRunId (scopes all queries)"]
        RT_SET["SETS (trades table):\n• id (UUID)\n• status: OPEN → CLOSED\n• pnl (computeTradePnl)\n• realizedPnl (accumulated TRIMs)\n• avgEntryPrice (ADD: weighted avg)\n• legs mutation (LEG_OFF: kept leg only)"]
        RT_EMITS["EMITS (trade_events):\n• Immutable event per action\n• price, quantity, messageId, timestamp\n• metadata (LEG_OFF: keptLeg, closedLeg)"]
    end

    LLM_Stage --> Norm_Stage
    Norm_Stage --> Agent_Stage
    Agent_Stage --> Pipeline_Stage
    Pipeline_Stage --> RecordTrade_Stage
```

---

## 5. OPEN Intent Normalization: OPEN vs ADD Decision

This diagram shows how the normalizer distinguishes a new position (OPEN) from an add-to-position (ADD) — a distinction the LLM no longer needs to make.

```mermaid
flowchart TD
    START["LLMSignal\nintent: OPEN\nsymbol: AAPL\ndirection: LONG\nstrategy: CDS"] --> QUERY

    QUERY["normalizeSignal()\ngetOpenPositions(symbol=AAPL, trader, strategy=CDS)"]

    QUERY --> |"returns []"| NO_POS
    QUERY --> |"returns [Trade{...}]"| HAS_POS

    NO_POS["No open position\n→ InternalSignal{action: OPEN}"]
    HAS_POS["Existing open position\n→ InternalSignal{action: ADD, tradeId: existing.id}"]

    NO_POS --> PIPE_OPEN["executeOpen()\n• resolveSignalLegs\n• calculatePositionSize\n• checkRiskLimits\n• placeOrder\n• recordTrade{action:OPEN}"]

    HAS_POS --> PIPE_ADD["executeAdd()\n• resolveSignalLegs\n• calculatePositionSize (add qty)\n• checkRiskLimits (OPEN-level)\n• placeOrder\n• recordTrade{action:ADD, avg entryPrice}"]
```

---

## 6. Normalizer Edge Cases

```mermaid
flowchart TD
    subgraph EC1 ["Edge Case: CLOSE with no open position"]
        EC1_IN["LLMSignal{intent:CLOSE, symbol:AAPL}"]
        EC1_NORM["normalizeSignal: getOpenPositions → []"]
        EC1_OUT["InternalSignal{action:CLOSE, direction:LONG*, strategy:STOCK*}\n* fallback defaults — pipeline will return executed:false"]
        EC1_IN --> EC1_NORM --> EC1_OUT
    end

    subgraph EC2 ["Edge Case: CLOSE with strategy mismatch (fuzzy match)"]
        EC2_IN["LLMSignal{intent:CLOSE, symbol:AAPL}"]
        EC2_NORM["normalizeSignal: getOpenPositions(symbol=AAPL) → [Trade{strategy:PUT}]"]
        EC2_OUT["InternalSignal{action:CLOSE, direction from pos, strategy from pos}\nfindPosition() in executeClose does own fuzzy fallback"]
        EC2_IN --> EC2_NORM --> EC2_OUT
    end

    subgraph EC3 ["Edge Case: OPEN with allowedStrategies gate"]
        EC3_IN["LLMSignal{intent:OPEN, strategy:CDS}"]
        EC3_GATE["normalizeSignal → InternalSignal{action:OPEN}\nAgent: shouldSkipSignal(signal, allowedStrategies=['STOCK','PUT'])\n→ NO_OP (strategy not allowed)"]
        EC3_IN --> EC3_GATE
    end

    subgraph EC4 ["Edge Case: LEG_OFF enrichment"]
        EC4_IN["LLMSignal{intent:LEG_OFF, symbol:UNH, targetStrategy:CALL}"]
        EC4_NORM["normalizeSignal: getOpenPositions → [Trade{direction:LONG, strategy:CDS}]\nSets direction:LONG, strategy:CDS on InternalSignal"]
        EC4_OUT["InternalSignal{action:LEG_OFF, direction:LONG, strategy:CDS, targetStrategy:CALL}"]
        EC4_IN --> EC4_NORM --> EC4_OUT
    end
```

---

## Summary: What Changes vs What Stays

| Component | Status | Change |
|---|---|---|
| `extract-intent.ts` prompt | **CHANGES** | Remove ADD from outputs; direction/strategy optional on CLOSE/TRIM/LEG_OFF |
| `agent/schemas.ts` — `SignalSchema` | **CHANGES** | Rename to `LLMSignalSchema`; `intent` replaces `action`; direction/strategy optional |
| `normalizer.ts` | **NEW** | Maps `LLMSignal` → `InternalSignal`; OPEN+position → ADD; enriches direction/strategy |
| `agent/schemas.ts` — `InternalSignalSchema` | **UNCHANGED** (= current `SignalSchema`) | All 5 actions, direction+strategy always required |
| `trading/trade-agent.ts` | **UNCHANGED** | Receives `InternalSignal`, same logic |
| `pipeline/execute.ts` | **UNCHANGED** | Receives `InternalSignal`, same 5-branch switch |
| `trades/record-trade.ts` | **UNCHANGED** | Receives `RecordTradeInput`, same logic |
| `backtest/runner.ts` | **MINIMAL CHANGE** | Call `normalizeSignal()` before `tradeAgent.onSignal()` |
| `messageIntents` DB table | **SCHEMA CHANGE** | `signals` JSON column stores `LLMSignal[]` instead of `Signal[]` |
| DB `trades` table | **UNCHANGED** | Still stores 5 internal actions |

# Trade Follower v0 — What's Implemented

> Messages arrive from SignalR → get parsed → agent decides to execute or flag → stocks, single options, and CDS/PDS spreads get placed on TradeStation → everything is logged for audit.

---

## Stack

- **Runtime:** Node 20, TypeScript, ESM
- **DB:** SQLite via drizzle-orm + @libsql/client
- **Browser:** Playwright (persistent context for session reuse)
- **Chat:** jQuery SignalR hook on OneOption's `chatHub.addMessage`
- **Agent:** Anthropic API (Claude Sonnet) with tool use loop
- **Broker:** TradeStation REST v3

---

## Database (SQLite)

5 tables, all defined in `src/db/schema.ts`:

| Table | Purpose |
|-------|---------|
| `messages` | Every chat message, parsed fields, confidence score |
| `tasks` | Work items created from badged messages by tracked traders |
| `task_steps` | Audit trail of each agent tool call + reasoning |
| `trades` | Executed positions with entry/exit tracking |
| `tracked_traders` | Whitelist with per-trader allocation limits |

Migrations generated via `drizzle-kit generate`, run via `npm run db:migrate`.

---

## Pipeline

```
SignalR message
    │
    ▼
Parse + Classify (deterministic, no LLM)
    │  HTML strip, badge extraction, symbol extraction,
    │  strategy regex, paper trade check, confidence score
    │
    ▼
Store in messages table (every message, regardless)
    │
    ▼
Task Factory
    │  Tracked trader? Has badge? Not paper?
    │  Yes → create task
    │  confidence >= 0.7 → EXECUTE_TRADE
    │  confidence <  0.7 → REVIEW_MESSAGE
    │
    ▼
Task Runner (polls PENDING tasks)
    │
    ▼
Agent (Claude Sonnet, up to 10 tool-use turns)
    │  Uses 6 tools to validate + execute or flag
    │
    ▼
Record results (task_steps, tasks.result, trades)
```

---

## Parsing

5 files in `src/parsing/`:

- **html.ts** — Cheerio-based HTML→text, strips blockquotes (quoted replies)
- **badges.ts** — Extracts `<span class="badge">` text: Long, Short, Exit. Derives actionHint (OPEN/CLOSE) and directionHint (LONG/SHORT)
- **symbols.ts** — Pulls tickers from `data-symbol` attributes on `<a>` tags
- **strategy.ts** — Regex detection for CDS, PDS, CALL, PUT, STOCK. Extracts strikes, price, quantity, expiry
- **classify.ts** — Combines all parsers into a `MessageClassification` with confidence score

Tested against real messages from the existing 23,573-message DB. Results:

| Message type | Confidence | needsAgent |
|-------------|-----------|------------|
| `Long MSTR $173.10 - 1,000 Shares` | 0.92 | no |
| `Long META CDS $630/$640 for $3 - 25 Contracts` | 0.96 | no |
| `Short SPOT 570/565 PDS for $2.05` | 0.96 | no |
| `Long META 625 call 8.65` | 0.94 | no |
| `Exit Long META $612.7` | 0.92 | no |
| `Short KKR sep 26 put (paper)` | skip | paper_trade |
| No badge messages | skip | no_badge |

---

## Agent

Defined in `src/agent/trade-agent.ts`. Uses the Anthropic API directly (not the Agent SDK) with an agentic tool-use loop.

### 6 Tools (`src/agent/tools.ts`)

| Tool | Purpose |
|------|---------|
| `get_quote` | Current bid/ask/last from TradeStation |
| `get_options_chain` | Options chain filtered by expiry + type |
| `get_open_positions` | Query open trades from DB (for exits) |
| `check_risk_limits` | Daily P&L, position count, allocation limits |
| `place_order` | Execute stock, single-leg, or multi-leg order |
| `flag_for_review` | Mark as MANUAL_REVIEW with reason |

### Decision flow

- **High confidence path** (clean regex match): get_quote → check_risk_limits → place_order. ~2-3 tool calls.
- **Low confidence path** (ambiguous): more tools to interpret, may flag_for_review. ~5-7 tool calls.
- **Exit path**: get_open_positions → no position? skip. Has position? place_order to close.

---

## Broker

`src/broker/tradestation.ts` — 3 functions:

- `getQuote(symbol)` — GET `/marketdata/quotes/{symbol}`
- `getOptionsChain(symbol, expiry, type)` — GET `/marketdata/options/chains/{symbol}`
- `placeOrder(params)` — POST `/orderexecution/orders`, supports stocks, single-leg options, and multi-leg spreads (CDS/PDS via Legs array)

Auth via `src/broker/auth.ts` — OAuth2 refresh token flow, auto-refreshes before expiry.

---

## Ingestion

`src/ingestion/browser.ts` — Playwright persistent browser context pointing at `https://app.oneoption.com/chat`. Handles login (auto via env vars or manual wait).

`src/ingestion/signalr.ts` — Injects a JS hook via `page.exposeFunction` + `page.evaluate` that intercepts `chatHub.addMessage` calls. Based on the working implementation in `trade-follower-2`.

SignalR message shape: `{ Id, MessageText, User: { Name }, PostTime, Tag, Votes, Reactions }`

---

## File Map

```
src/
├── db/
│   ├── schema.ts              # 5 tables + all TypeScript types
│   ├── client.ts              # Drizzle + libsql
│   ├── migrate.ts             # Run migrations
│   └── seed.ts                # Seed tracked_traders
├── ingestion/
│   ├── browser.ts             # Playwright launch + auth
│   ├── signalr.ts             # chatHub hook injection
│   └── ingest.ts              # Orchestrator
├── parsing/
│   ├── html.ts                # HTML → clean text
│   ├── badges.ts              # Badge extraction
│   ├── symbols.ts             # data-symbol extraction
│   ├── strategy.ts            # CDS/PDS/CALL/PUT/STOCK regex
│   └── classify.ts            # Combine → MessageClassification
├── broker/
│   ├── types.ts               # Quote, OptionsChain, OrderResult
│   ├── auth.ts                # OAuth2 refresh flow
│   └── tradestation.ts        # TradeStation API client
├── agent/
│   ├── trade-agent.ts         # Anthropic agentic loop
│   └── tools.ts               # 6 tool definitions
├── tasks/
│   ├── factory.ts             # Message → Task creation
│   ├── runner.ts              # Poll + dispatch + record trades
│   └── recorder.ts            # Write steps/results to DB
├── config/
│   └── traders.ts             # Tracked trader cache
└── index.ts                   # Entry point
```

22 files total. Zero type errors.

---

## Environment Variables

```
DATABASE_URL=file:data/trade-follower.db
TS_CLIENT_ID=
TS_CLIENT_SECRET=
TS_REFRESH_TOKEN=
TS_ACCOUNT_ID=
ANTHROPIC_API_KEY=
ONE_OP_EMAIL=
ONE_OP_PASS=
CHAT_URL=https://app.oneoption.com/chat
HEADLESS=false
```

---

## Commands

```bash
npm run db:generate   # Generate migration SQL from schema
npm run db:migrate    # Apply migrations
npm run db:seed       # Insert tracked traders
npm run dev           # Start the pipeline
```

---

## What's NOT in v0

- Dashboard / API / WebSocket
- Backtesting (sim broker, clock, replay)
- Exotic strategies (butterfly, iron condor, time spread, BPS, BCS)
- Multi-trade message splitting
- Partial exits / adjustments
- Unbadged trade detection
- Plain-text ticker extraction (only data-symbol attrs)
- Per-trader stats/history tools
- `get_message_context` tool

---

## Existing Data

23,573 messages in `/Users/jason/trade-follower-2/data/trades.db` with schema:

```
messages(id, content, author, time_utc, tag, votes, reactions, created_at, raw_json, preprocessed)
```

`raw_json` contains the original SignalR payload. `content` is the HTML. Available for backtest seeding.

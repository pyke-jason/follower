# AGENTS.md

## What this project is

Trade Follower 3 -- an autonomous trade-copy system that monitors a live trading chat room, classifies messages using an AI agent, and mirrors trades via broker APIs. Includes backtesting, evaluation, and a dashboard.

**Stack:** TypeScript (ESM) backend (`src/`), Vite + React SPA frontend (`web/src/`), Postgres via Drizzle ORM, Hono local API.

**Pipeline:** Chat message -> parser (sync, zero I/O) -> orchestrator routing -> executor -> broker -> record trade.

## The one rule

**Own the outcome.** You are not done when the code compiles. You are done when the feature works. Run `/verify` after building anything. See `.agents/skills/verify/SKILL.md` for the full protocol.

## How to work

1. **Read the docs first.** `docs/rails.md` is the authoritative coding standards reference -- read it before writing code. `.claude/rules/` has domain-specific rules loaded contextually by file path. `web/AGENTS.md` has frontend-specific rules and the UI cookbook.
2. **Verify your work.** Run `/verify` after building or changing features. It starts the dev server, interacts via Playwright, runs quality gates, and fixes anything broken.
3. **Use the scratchpad.** `scratchpad/` is your workbench for throwaway scripts with REAL data. Run via `npx tsx scratchpad/debug-xxx.ts`. Delete when verified.

## Commands

```bash
npm run up               # Start everything (backend + web + local API)
npm run up:ui            # Start web + local API only (no backend)
npm run dev              # Backend only (ingestion + agent + reconciliation)
npm run web              # Vite dev server on :3000
npm run local-api        # Hono local API on :3791
npm run backtest         # Launch backtest (tsx src/backtest/launch.ts)
npm run gateway          # Start IBC/IBKR gateway
npm run db:generate      # Generate Drizzle migrations
npm run db:migrate       # Apply migrations
npm run secrets:import   # Import .env keys to macOS Keychain
npm test                 # Vitest
npm run build            # Build web frontend
```

**Quality gates (must pass before declaring done):**
```bash
npx tsc --noEmit && npm test && npm --prefix web run check && npx knip
```

`knip` fails on orphan files and unused dependencies. New orphans = not done. Don't silence it with `ignore` entries — fix the cruft. See `knip.json` for config.

## Key references

| What | Where |
|------|-------|
| Coding standards (authoritative) | `docs/rails.md` |
| Frontend data patterns | `docs/rails/frontend-data.md` |
| shadcn/ui component guide | `docs/rails/shadcn.md` |
| UI cookbook (intent-driven) | `web/docs/cookbook/` |
| Frontend rules | `web/AGENTS.md` |
| Schema (source of truth) | `src/db/schema.ts` |
| Domain-specific rules | `.claude/rules/` (loaded contextually) |
| Implementation notes | `docs/local-implementation-rails.md` |
| IBKR TWS API reference | `docs/ibkr/` |
| IBKR sidecar | `sidecar/` (Java) |
| IBKR TS client | `src/broker/ibkr/` |

## Path aliases

- Backend `@/*` -> `src/*`. Use `@/db/schema.js`, never `../../db/schema`.
- Frontend `@/*` -> `web/src/*`. Use `@/components/ui/button`, `@/lib/api`.
- Cross-boundary `@src/*` -> `../src/*` in web. Use `@src/db/schema`, never relative paths.

## Signal pipeline

Message -> parser (sync, zero I/O) -> routing (hard skip / deterministic open-close / LLM fallback) -> execution -> broker -> record trade. Prefer deterministic paths over LLM. See `.claude/rules/orchestrator.md` for the full routing diagram.

## Domain glossary

- **Actions:** `OPEN` (entry), `ADD` (scale into existing position), `TRIM` (partial close, `exitPercent` in 0..1), `CLOSE` (full exit), `LEG_OFF` (close one leg of a spread, keep `targetStrategy`).
- **Strategies:** `STOCK`, `CALL`, `PUT` (single-leg), `CDS`/`PDS` (call/put debit spread), `CCS`/`PCS` (call/put credit spread). Spread direction is derived from leg structure, not the `direction` field.
- **Direction:** `LONG`/`SHORT` means buying vs selling the instrument — not a bullish/bearish view.
- **Fill models (backtest):** `orats` (bid-ask width + leg count estimate), `midpoint`, `natural` (buy ask / sell bid).
- **Run scoping:** Live data has no run scope; backtest data is isolated per `channelId = 'bt:<runId>'`. Dashboard pages accept `?run=<id>` for scoped views.
- **Agent:** `Agent` (`src/agent/result.ts`) is the provider-agnostic interface. `createAgent(identity)` returns `AnthropicAgent` (via `@anthropic-ai/claude-agent-sdk`) or `XAIAgent` (via `@ai-sdk/xai`).

## Coding standards

`docs/rails.md` is the single source of truth. Read it before writing code. The most-violated rule:

- **Pipeline code is shared.** Never add `if (isBacktest)` branches in `src/pipeline/` or `src/orders/`. Differences belong in `BrokerService` implementations.

Frontend rules are in `.claude/rules/shadcn-ui.md` and `.claude/rules/web-components.md` (loaded contextually). Database rules are in `.claude/rules/data-context.md` and `.claude/rules/database-trades.md`.

## Database

Schema: `src/db/schema.ts`. Transactions: `runTx()` from `src/db/client.ts`. Channel scoping: all data scoped by `channelId` (helpers in `src/lib/channel.ts`). See `.claude/rules/data-context.md` for operational warnings (WAL, Databento costs, foreign keys).

## Environment

- Do not read `.env` directly -- rely on environment variables or the secrets provider.
- Secrets live in macOS Keychain (primary) with `.env` fallback. See `src/lib/secrets/`.
- Required: `ANTHROPIC_API_KEY`. Optional: `DATABENTO_API_KEY`, broker credentials, alert webhooks.

## Workflows

### Lessons (mandatory)
After every implementation session (new features, bugs, schema changes), create a lesson file:
- Location: `docs/lessons/YYYY-MM-DD-slug.md`
- Sections: Problem, Decision, Key Files, Watch Out
- Plain text, flat, scannable

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files. If it is absent, use `graphify-out/GRAPH_REPORT.md`.
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)

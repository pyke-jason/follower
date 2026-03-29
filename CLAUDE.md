# CLAUDE.md

## What this project is

Trade Follower 3 -- an autonomous trade-copy system that monitors a live trading chat room, classifies messages using an AI agent, and mirrors trades via broker APIs. Includes backtesting, evaluation, and a dashboard.

**Stack:** TypeScript (ESM) backend (`src/`), Vite + React SPA frontend (`web/src/`), SQLite via Drizzle ORM, Hono local API.

**Pipeline:** Chat message -> parser (sync, zero I/O) -> orchestrator routing -> executor -> broker -> record trade.

## The one rule

**Own the outcome.** You are not done when the code compiles. You are done when the feature works. If a page doesn't render, a button doesn't work, or a layout looks broken, that's your problem to fix, not the human's problem to discover.

## How to work

1. **Read the docs first.** `docs/rails.md` is the authoritative coding standards reference -- read it before writing code. `.claude/rules/` has domain-specific rules loaded contextually by file path. `web/CLAUDE.md` has frontend-specific rules and the UI cookbook.

2. **Verify your own work like a user, not a CI pipeline.** After you build something:
   - Start the dev server (`npm run up`) and confirm pages load
   - Open Playwright and use the feature the way the human would: click every button, fill in forms, scroll through lists, try edge cases (empty fields, long text, missing data)
   - Create real test data through the UI, then verify the DB actually changed. Clean up when done.
   - Run the quality gates: `npx tsc --noEmit && npm test && npm --prefix web run check`
   - If something looks wrong or broken, fix it -- don't report it and stop
   - A screenshot of an empty state proves nothing. The only proof is: you used it and it worked.

3. **Use the scratchpad.** `scratchpad/` is your workbench for throwaway scripts with REAL data. Run via `npx tsx scratchpad/debug-xxx.ts`. Delete when verified.

4. **Iterate until it's right.** Your first attempt might not work. Debug it, fix it, try again. The goal is a working feature, not a submitted diff.

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
npx tsc --noEmit && npm test && npm --prefix web run check
```

## Key references

| What | Where |
|------|-------|
| Coding standards (authoritative) | `docs/rails.md` |
| Frontend data patterns | `docs/rails/frontend-data.md` |
| shadcn/ui component guide | `docs/rails/shadcn.md` |
| UI cookbook (intent-driven) | `docs/cookbook/` |
| Frontend rules | `web/CLAUDE.md` |
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

### Landing the plane
Do not make commits. The user handles all git operations.

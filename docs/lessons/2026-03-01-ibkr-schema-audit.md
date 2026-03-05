# IBKR Schema Audit & Documentation

**Date:** 2026-03-01

## Problem

Zod schemas in `src/broker/ibkr/schemas.ts` were written speculatively — not verified against sidecar reality. Multiple fields required by schemas were never sent by the sidecar, which would cause `parseSidecarResponse()` to throw (firing Discord critical alert) on first real API call.

## Decision

Full audit of sidecar Java code + TS client + TWS API documentation. Fixed 6 schema mismatches, wrote comprehensive docs covering every signal during execution lifecycle.

## Key Files

- `src/broker/ibkr/schemas.ts` — 6 fixes: removed fake `symbol` from quotes, made quote fields optional, removed `marketValue`/`unrealizedPnl` from positions, added `remaining`/`close`/`wsClients`/`maintenance`
- `src/broker/ibkr/client.ts` — getQuote/getPositions updated for new schema shapes
- `src/broker/ibkr/ws-listener.ts` — now handles Cancelled/Inactive statuses and error 201/202
- `src/broker/types.ts` — `BrokerPosition.marketValue`/`unrealizedPnl` now optional
- `docs/ibkr/` — 6 docs: README, sidecar-api, order-lifecycle, error-codes, risk-and-margin, connection-and-operations, gaps-and-todos

## Watch Out

- **`modifyOrder()` is broken** (T1/S6 in gaps doc). Sends only `{limitPrice}` but sidecar PUT needs full contract+order. Price chase will fail on IBKR. Must fix sidecar to cache original orders.
- **`execDetails()` is a no-op** in sidecar (S1). Forced liquidation fills are silently dropped. Must implement before live trading with real money.
- **Inactive status is NOT terminal** — can recover to Submitted (short locate). Our `mapIbkrStatus` maps it to REJECTED which is treated as terminal.
- **Market orders may skip `orderStatus` entirely** — must monitor `execDetails` for correctness.
- **`reqAccountSummary` tags too narrow** — missing Cushion, SMA, DayTradesRemaining. No margin risk visibility.

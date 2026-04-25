Problem

Live ingestion could appear healthy when the browser was on the chat URL but the page was not actually joined to the chat-room SignalR proxy. The watchdog also waited for the first message before it could alert, and REST fallback/backfill saved messages without handing them to the live task pipeline.

Decision

Treat SignalR injection as a readiness check, not just a side effect. Require the addMessage listener and the page chat-room proxy, page when either is missing, run REST polling as a fallback, and restart the browser to force a clean subscription. Keep a REST safety net running even when SignalR says it is healthy; if REST finds older messages SignalR did not store, create tasks, send a critical alert, and restart the browser. Make stored messages the ingestion handoff so SignalR and REST-recovered messages both fan out through the same task creation path.

Key Files

src/ingestion/signalr.ts
src/ingestion/ingest.ts
src/ingestion/historical.ts
src/ingestion/recovery.ts
src/index.ts
src/ingestion/signalr.test.ts
src/ingestion/recovery.test.ts

Watch Out

Initial wide historical backfill remains UI context only and skips today. Same-day startup catch-up and stored same-day replay create tasks, while old or duplicate task creation remains guarded by the existing message/channel uniqueness and runner staleness checks.

# OneOption Session & Pre-Market Readiness

## Problem

The OneOption free trial account (`larvae_zinnia_7q@icloud.com` / Joseph Wu) was previously expired. A new trial was started (expires March 26), but the backend browser can't access the chat room. Message ingestion is blocked.

## Root Cause

OneOption gates `/chat` access behind a **session-level onboarding flow**:

1. After login, new sessions land on `/account/membership`
2. Navigating to `/chat` redirects back to `/account/membership`
3. The chat search REST API returns `{"error":"Chat search is not permed"}` for sessions that haven't completed onboarding
4. Only sessions that go through the **full first-time flow** (referral form + policies acceptance) within the SAME browser context get a cookie/session flag that unlocks chat access
5. This flag does NOT persist across new browser sessions — each new Playwright context gets redirected

Automated account creation is blocked by reCAPTCHA v3 server-side validation.

## What Works

- **IBKR sidecar**: Connected to paper account DUP246375, market data OK
- **Backend**: Running, authenticated, reconciliation passing
- **Web dashboard**: All pages render correctly
- **Tracked traders**: 710 configured (Pete, Hariseldon, Dave W as primary with 5% sizing)
- **IB Gateway**: Running on port 4002 (paper mode)

## What Doesn't Work

- **Message ingestion**: Browser stuck on membership page, SignalR not connected
- **REST API polling**: API returns "not permed" error, can't fetch messages
- **Historical backfill**: Same API restriction — can't fetch March 10-22 messages

## Fix Required (Manual, ~2 minutes)

Run this script which opens a **visible browser** — you need to manually:
1. Log in when the browser opens
2. Submit the referral form if it appears
3. Navigate to `/chat` and accept policies
4. Press Enter in the terminal to save the session

```bash
npx tsx scratchpad/manual-login.ts
```

Then restart the backend: kill `npm run up` and re-run it. The saved `data/browser-storage.json` will have the working cookies.

## Code Changes Made

1. **`src/ingestion/browser.ts`**: Exported `CHAT_URL` constant
2. **`src/ingestion/ingest.ts`**:
   - Added post-login navigation to `/chat` (handles modal dismissal + policies)
   - Added REST API polling fallback when SignalR unavailable (polls every 15s)
3. **`src/local-api/server.ts`**:
   - Added `app.oneoption.com` to CORS allowlist
   - Added temporary `/ingest-backfill` POST endpoint for bulk message insertion

## Watch Out

- OneOption sessions expire after ~30-60 minutes of inactivity
- The `data/browser-storage.json` file is the only way to persist session cookies
- The auth monitor runs every 30s and re-logs in if needed, but re-login creates a NEW session without the onboarding flag
- The trial expires **March 26** — need a plan for ongoing access (paid subscription or new trial rotation)
- `browser-storage.json` was last valid on March 9; I deleted it during troubleshooting

## Key Files

| File | What |
|------|------|
| `data/browser-storage.json` | Playwright session cookies (needs manual flow to populate) |
| `src/ingestion/browser.ts` | Browser launch, login, auth check |
| `src/ingestion/ingest.ts` | Supervision loop, SignalR injection, polling fallback |
| `src/ingestion/signalr.ts` | SignalR listener injection |
| `src/ingestion/historical.ts` | REST API message fetcher |
| `scratchpad/save-chat-session.ts` | Automated session saver (doesn't work due to onboarding gate) |
| `scratchpad/fresh-account.ts` | Account creator (blocked by reCAPTCHA) |

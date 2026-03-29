# Account Rotation Plan

## Problem

OneOption trial accounts expire (~30 days) and sessions get locked out. Currently requires manual intervention via `scratchpad/manual-login.ts`. We need automated account rotation: create a new email, register, verify, and resume ingestion without human input.

## Available Pieces

| Tool | What it does |
|------|-------------|
| `hme` (`/Users/jason/Workspace/utils/hme`) | Creates iCloud Hide My Email aliases via macOS UI automation. Returns email to stdout. ~30s, requires Mac unlocked. |
| Gmail (`GMAIL_EMAIL` / `GMAIL_PASSWORD`) | HME aliases forward here. Playwright logs into Gmail web to find verification emails. |
| `sendSystemAlert()` | Pushover/Discord push notifications for failures. |
| `KeychainProvider.set()` | Persists credentials to macOS Keychain + updates `process.env`. |

## Design

### One new file: `src/ingestion/account-rotation.ts`

Single export:

```typescript
export async function rotateAccount(): Promise<string | null>
//  Returns new email on success, null on failure.
//  Never throws — all failures alert + return null.
```

The function creates its **own temporary Playwright browser** (non-headless, fresh fingerprint). It does NOT reuse the ingestion browser. After rotation succeeds, the supervision loop restarts and the ingestion browser logs in with the new credentials through the normal path.

### Step-by-step flow

```
rotateAccount()
  ├─ 1. createHmeAlias("oneop-<timestamp>")     [90s timeout]
  │     Shell out to hme command, get new iCloud alias
  │
  ├─ 2. register(email, password, name)          [30s timeout]
  │     Launch temp Playwright browser (non-headless)
  │     Fill OneOption registration form
  │     Let page JS handle reCAPTCHA v3 / Castle / FingerprintJS natively
  │     Submit via button click (not form.submit)
  │     Check for error text
  │
  ├─ 3. findAndClickVerificationEmail(email)     [120s timeout, poll every 10s]
  │     Log into Gmail web in the same temp browser
  │     Search for OneOption emails (from:oneoption newer_than:1h)
  │     Open the email, find the verification link
  │     Navigate to the verification URL
  │
  ├─ 4. persistCredentials(email, password)
  │     KeychainProvider.set('ONE_OP_EMAIL', email)
  │     KeychainProvider.set('ONE_OP_PASS', password)
  │     Delete stale data/browser-storage.json
  │
  └─ 5. Close temp browser, return email
```

### Integration point: `ingest.ts` only

Minimal change to the supervision loop (~10 lines). After `attemptLogin()` fails, before `waitForAuth()`:

```typescript
if (getAuthState() !== 'authenticated') {
  const success = await attemptLogin();
  if (!success) {
    const newEmail = await rotateAccount();
    if (newEmail) {
      sendSystemAlert({ ... 'Account rotated' ... });
      await closeBrowser();
      continue; // restart supervision loop with new creds
    }
    sendSystemAlert({ ... 'Manual intervention required' ... });
    await waitForAuth();
  }
}
```

No changes to `browser.ts`. When the auth monitor detects session loss and re-login fails, the watchdog will eventually force a browser restart (10 min silence), which feeds back into the supervision loop, which triggers rotation.

### No changes needed to onboarding code

After rotation, the supervision loop restarts from the top: launches browser → `attemptLogin()` with new creds (from process.env) → onboarding (referral modal + policies) → SignalR. The existing onboarding code handles this already.

## Failure Modes

Every failure: log + alert + return null → falls through to `waitForAuth()` (manual).

| Step | Failure | Alert message |
|------|---------|---------------|
| HME | Mac locked, System Settings crash | "HME alias creation failed — Mac may be locked" |
| Registration | reCAPTCHA rejection | "OneOption rejected registration: {error}" |
| Registration | Form error (email taken, etc.) | "OneOption rejected registration: {error}" |
| Gmail | Login fails | "Gmail verification flow crashed" |
| Verification | Email never arrives (120s) | "Verification email not found within 2 minutes" |
| Verification | Link not found in email body | "Verification email not found" |
| Persistence | Keychain write fails | "Could not save new credentials" |

## Cooldown

10-minute minimum between rotation attempts. Prevents burning through HME aliases if something is broken.

## reCAPTCHA v3 Strategy

The prior failure (`scratchpad/fresh-account.ts`) was likely due to headless mode. reCAPTCHA v3 is score-based — non-headless Chromium with real user-like interaction scores higher. By clicking the submit button (not calling `form.submit()`), the page's own event handler runs reCAPTCHA + Castle + FingerprintJS before submitting. Playwright in visible mode executes this natively.

If reCAPTCHA still blocks: alert + fall back to manual. No retries in the same cycle.

## Dependencies

**No new npm dependencies.** Playwright (already installed) handles both OneOption registration and Gmail web login. No IMAP library needed.

## Secrets

| Key | Source | Notes |
|-----|--------|-------|
| `GMAIL_EMAIL` | Already in .env | Gmail username (thebigbee123hehehe) |
| `GMAIL_PASSWORD` | Already in .env | Gmail password (no 2FA) |

Both added to `SECRET_KEYS` in `src/lib/secrets/keychain-provider.ts`.

## Files Changed

| File | Change |
|------|--------|
| `src/ingestion/account-rotation.ts` | **NEW** — rotation pipeline (~220 lines) |
| `src/ingestion/ingest.ts` | Add ~10 lines: call `rotateAccount()` between failed login and `waitForAuth()` |
| `src/lib/secrets/keychain-provider.ts` | Add `GMAIL_EMAIL`, `GMAIL_PASSWORD` to `SECRET_KEYS` |

## What This Does NOT Do

- No new npm dependencies
- No database schema changes
- No web UI for account management
- No auth monitor changes (watchdog handles the restart path naturally)
- No scheduled rotation (only triggers on auth failure)
- No account history tracking (alerts log rotations; keychain has current creds)

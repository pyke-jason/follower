import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { sendSystemAlert } from '../lib/alert.js';
import { PATHS } from '../lib/paths.js';
import { isoToDateKey } from '../lib/et-date.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

type AuthState = 'unknown' | 'authenticated' | 'unauthenticated';

export const CHAT_URL = process.env.CHAT_URL || 'https://app.oneoption.com/chat';
const STORAGE_STATE_PATH = resolve(PATHS.data, 'browser-storage.json');

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let authState: AuthState = 'unknown';
let authMonitorTimer: ReturnType<typeof setInterval> | null = null;
let lastTrialCheckAt = 0;
let trialRotationTriggered = false;

function isPageAlive(): boolean {
  return page !== null && !page.isClosed();
}

function resetBrowser(): void {
  stopAuthMonitor();
  page = null;
  context = null;
  browser = null;
  authState = 'unknown';
}

export async function launchBrowser(): Promise<{ page: Page; crashed: Promise<void> }> {
  if (page) {
    const crashed = new Promise<void>(resolve => {
      page!.on('close', () => resolve());
    });
    return { page, crashed };
  }

  console.log('[Browser] Launching...');

  browser = await chromium.launch({
    headless: process.env.HEADLESS === 'true',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  // Restore cookies from previous session if available
  const storageState = existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined;
  if (storageState) {
    console.log('[Browser] Restoring saved session cookies');
  }

  context = await browser.newContext({ storageState });
  page = await context.newPage();

  const crashed = new Promise<void>(resolve => {
    browser!.on('disconnected', () => {
      console.log('[Browser] disconnected event');
      resolve();
    });
  });

  console.log(`[Browser] Navigating to ${CHAT_URL}...`);
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const landingUrl = page.url();
  console.log(`[Browser] Landed on: ${landingUrl}`);

  await acceptPoliciesIfNeeded(page);

  authState = await checkAuth(page);
  return { page, crashed };
}

/**
 * If the page is the chat policies agreement gate, tick the "I understand"
 * checkbox and submit. The form POSTs to /chat/acceptpolicies and redirects
 * back to /chat. Safe to call on any page — no-ops when the gate is absent.
 * Returns true iff the gate was present and accepted.
 */
async function acceptPoliciesIfNeeded(p: Page): Promise<boolean> {
  const checkbox = p.locator('input#understand');
  if ((await checkbox.count()) === 0) return false;

  console.log('[Browser] Chat policies agreement gate detected — accepting');
  try {
    await checkbox.waitFor({ state: 'visible', timeout: 10_000 });
    if (!(await checkbox.isChecked())) {
      await checkbox.check();
    }
    await Promise.all([
      p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
      p.click('input#continue'),
    ]);
    console.log(`[Browser] Policies accepted — now on: ${p.url()}`);
    return true;
  } catch (err) {
    console.error('[Browser] Failed to accept policies:', err);
    return false;
  }
}

async function checkAuth(p: Page): Promise<AuthState> {
  const url = p.url();
  if (url.includes('/Account/Login') || url.includes('/login')) {
    if (authState !== 'unauthenticated') {
      console.log('[Browser] Not authenticated (on login page)');
    }
    return 'unauthenticated';
  }

  // Verify with API call
  const today = isoToDateKey(new Date().toISOString());
  const testUrl = `https://app.oneoption.com/chat/search-messages?term=&author=&since=${today}&until=${today}`;

  const result = await p.evaluate(async (fetchUrl: string) => {
    try {
      const resp = await fetch(fetchUrl, { redirect: 'manual' });
      const text = await resp.text();
      return {
        isRedirect: resp.type === 'opaqueredirect' || resp.status === 302,
        isJson: text.trim().startsWith('[') || text.trim().startsWith('{'),
        hasError: text.includes('"error"') || text.includes('not permed'),
      };
    } catch {
      return { isRedirect: false, isJson: false, hasError: false };
    }
  }, testUrl);

  if (result.isJson && !result.isRedirect && !result.hasError) {
    if (authState !== 'authenticated') {
      console.log('[Browser] Authenticated');
    }
    return 'authenticated';
  }

  if (result.hasError) {
    if (authState !== 'unauthenticated') {
      console.log('[Browser] Not authenticated (API returned error — chat not permed)');
    }
    return 'unauthenticated';
  }

  if (!result.isJson && !result.isRedirect) {
    console.warn('[Browser] Auth check returned ambiguous result — response was neither JSON nor a redirect');
  }

  if (authState !== 'unauthenticated') {
    console.log('[Browser] Not authenticated');
  }
  return 'unauthenticated';
}

/** Save cookies so the next launch can restore them without re-login. */
async function saveStorageState(): Promise<void> {
  if (!context) return;
  try {
    await context.storageState({ path: STORAGE_STATE_PATH });
  } catch {
    // Non-fatal — worst case we re-login next time
  }
}

export async function attemptLogin(): Promise<boolean> {
  if (!page) throw new Error('Browser not launched');

  const email = process.env.ONE_OP_EMAIL;
  const password = process.env.ONE_OP_PASS;
  if (!email || !password) {
    console.log('[Browser] No credentials in env (ONE_OP_EMAIL / ONE_OP_PASS)');
    return false;
  }

  console.log('[Browser] Attempting login...');

  try {
    // If we were redirected straight to the policies gate (cookies still
    // valid, just need to re-accept), click through and re-check auth.
    if (await acceptPoliciesIfNeeded(page)) {
      authState = await checkAuth(page);
      if (authState === 'authenticated') {
        await saveStorageState();
        return true;
      }
    }

    await page.fill('input#Email, input[name="Email"]', email);
    await page.fill('input#Password, input[name="Password"]', password);

    const rememberMe = page.locator('#RememberMe[type="checkbox"]');
    if (await rememberMe.count() > 0 && !(await rememberMe.isChecked())) {
      await rememberMe.check();
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);

    // New accounts land on the policies gate after the first successful login.
    await acceptPoliciesIfNeeded(page);

    authState = await checkAuth(page);
    if (authState === 'authenticated') {
      await saveStorageState();
    }
    return authState === 'authenticated';
  } catch (err) {
    console.error('[Browser] Login failed:', err);
    return false;
  }
}

export async function waitForAuth(): Promise<void> {
  if (authState === 'authenticated') return;
  if (!page) throw new Error('Browser not launched');

  console.log('[Browser] Waiting for manual login...');

  while (true) {
    await new Promise(r => setTimeout(r, 5000));
    if (!page) throw new Error('Browser closed during auth wait');
    await acceptPoliciesIfNeeded(page);
    authState = await checkAuth(page);
    if (authState === 'authenticated') {
      await saveStorageState();
      return;
    }
  }
}

export function getPage(): Page {
  if (!page) throw new Error('Browser not launched');
  return page;
}

export function getAuthState(): AuthState {
  return authState;
}

export function startAuthMonitor(intervalMs = 30_000): void {
  if (authMonitorTimer) return;

  console.log(`[Browser] Starting auth monitor (every ${intervalMs / 1000}s)`);
  authMonitorTimer = setInterval(async () => {
    if (!isPageAlive()) return;
    const currentPage = page!; // safe: isPageAlive() guarantees non-null

    try {
      const previous = authState;
      authState = await checkAuth(currentPage);

      if (previous === 'authenticated' && authState === 'unauthenticated') {
        sendSystemAlert({
          title: 'Chat room access lost',
          message: 'Session expired or login required — attempting re-login',
          severity: 'critical',
        });

        const recovered = await attemptLogin();
        if (!recovered) {
          sendSystemAlert({
            title: 'Re-login failed',
            message: 'Automatic re-login failed — manual intervention required',
            severity: 'critical',
          });
        }
      }

      if (previous === 'unauthenticated' && authState === 'authenticated') {
        sendSystemAlert({
          title: 'Chat room access restored',
          message: 'Successfully re-authenticated to chat room',
          severity: 'info',
        });
      }

      // Proactive trial expiry check (throttled to once per hour)
      if (authState === 'authenticated') {
        await checkTrialStatus(currentPage);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Race between the browser lifecycle (close/relaunch) and an in-flight tick
      // is benign — don't promote it to a WARNING alert.
      if (
        msg.includes('Target page, context or browser has been closed') ||
        msg.includes('Target closed') ||
        msg.includes('Browser not launched')
      ) {
        console.log(`[Browser] Auth monitor tick raced with browser lifecycle (${msg}) — ignoring`);
        return;
      }
      console.error('[Browser] Auth monitor check failed:', err);
      sendSystemAlert({
        title: 'Auth monitor error',
        message: `Auth check threw: ${msg}`,
        severity: 'warning',
      });
    }
  }, intervalMs);
}

// ─── Trial Status Monitor ──────────────────────────
// Checks /account/trial-status once per hour. When daysRemaining <= 2,
// signals the supervision loop to rotate before the trial expires.

const TRIAL_CHECK_INTERVAL_MS = 60 * 60_000; // once per hour
const TRIAL_ROTATE_THRESHOLD_DAYS = 2;

type TrialStatus = {
  daysRemaining: number;
  trialExpiresOn: string | null;
  extensionOffered: boolean;
  extensionUsed: boolean;
  hasPaidSubscription: boolean;
};

export function shouldRotateProactively(): boolean {
  return trialRotationTriggered;
}

export function clearProactiveRotationFlag(): void {
  trialRotationTriggered = false;
}

async function checkTrialStatus(p: Page): Promise<void> {
  if (Date.now() - lastTrialCheckAt < TRIAL_CHECK_INTERVAL_MS) return;
  lastTrialCheckAt = Date.now();

  try {
    const result = await p.evaluate(async () => {
      try {
        const resp = await fetch('/account/trial-status');
        if (!resp.ok) return null;
        return await resp.json();
      } catch { return null; }
    });

    if (!result || !result.success) return;

    // Parse .NET date format: /Date(1773215940000)/
    let expiresOn: string | null = null;
    if (result.currentExpiryDate) {
      const ms = parseInt(result.currentExpiryDate.replace(/\/Date\((\d+)\)\//, '$1'));
      if (!isNaN(ms)) expiresOn = new Date(ms).toISOString().slice(0, 10);
    }

    const days: number = result.daysRemaining ?? 0;
    const hasPaid: boolean = result.hasPaidSubscription ?? false;

    console.log(`[TrialCheck] Days remaining: ${days}, expires: ${expiresOn ?? 'unknown'}, paid: ${hasPaid}`);

    if (hasPaid) return; // paid subscription, no rotation needed

    if (days <= TRIAL_ROTATE_THRESHOLD_DAYS && !trialRotationTriggered) {
      trialRotationTriggered = true;
      sendSystemAlert({
        title: 'Trial expiring soon',
        message: `OneOption trial has ${days} day(s) remaining (expires ${expiresOn}). Proactive rotation will trigger on next supervision loop restart.`,
        severity: 'warning',
      });
      // Force browser close — the supervision loop will restart and see
      // shouldRotateProactively() === true, triggering rotation.
      closeBrowser().catch(() => {});
    }
  } catch (err) {
    // Non-fatal — trial check is best-effort
    console.warn('[TrialCheck] Failed:', err instanceof Error ? err.message : String(err));
  }
}

export function stopAuthMonitor(): void {
  if (authMonitorTimer) {
    clearInterval(authMonitorTimer);
    authMonitorTimer = null;
    console.log('[Browser] Auth monitor stopped');
  }
}

export async function closeBrowser(): Promise<void> {
  stopAuthMonitor();
  // Save cookies before closing so next launch can restore them
  await saveStorageState();
  const b = browser;
  browser = null;
  context = null;
  page = null;
  authState = 'unknown';
  if (b) {
    try {
      await b.close();
    } catch {
      // Browser already closed externally — that's fine
    }
  }
  // No orphan cleanup needed — chromium.launch() owns the process tree
  // and browser.close() terminates it atomically.
}

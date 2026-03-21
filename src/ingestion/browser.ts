import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { sendSystemAlert } from '../lib/alert.js';
import { PATHS } from '../lib/paths.js';
import { isoToDateKey } from '../lib/et-date.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type AuthState = 'unknown' | 'authenticated' | 'unauthenticated';

const CHAT_URL = process.env.CHAT_URL || 'https://app.oneoption.com/chat';
const STORAGE_STATE_PATH = resolve(PATHS.data, 'browser-storage.json');

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let authState: AuthState = 'unknown';
let authMonitorTimer: ReturnType<typeof setInterval> | null = null;

export function isPageAlive(): boolean {
  return page !== null && !page.isClosed();
}

export function resetBrowser(): void {
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

  authState = await checkAuth(page);
  return { page, crashed };
}

async function checkAuth(p: Page): Promise<AuthState> {
  const url = p.url();
  if (url.includes('/Account/Login') || url.includes('/login')) {
    console.log('[Browser] Not authenticated (on login page)');
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
      };
    } catch {
      return { isRedirect: false, isJson: false };
    }
  }, testUrl);

  if (result.isJson && !result.isRedirect) {
    console.log('[Browser] Authenticated');
    return 'authenticated';
  }

  if (!result.isJson && !result.isRedirect) {
    console.warn('[Browser] Auth check returned ambiguous result — response was neither JSON nor a redirect');
  }

  console.log('[Browser] Not authenticated');
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
    } catch (err) {
      console.error('[Browser] Auth monitor check failed:', err);
      sendSystemAlert({
        title: 'Auth monitor error',
        message: `Auth check threw: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'warning',
      });
    }
  }, intervalMs);
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

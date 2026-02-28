import { chromium, type Browser, type Page } from 'playwright';
import { sendSystemAlert } from '../lib/alert.js';
import { PATHS } from '../lib/paths.js';
import { isoToDateKey } from '../lib/et-date.js';

export type AuthState = 'unknown' | 'authenticated' | 'unauthenticated';

const CHAT_URL = process.env.CHAT_URL || 'https://app.oneoption.com/chat';
const USER_DATA_DIR = process.env.USER_DATA_DIR || PATHS.browserSession;

let browser: Browser | null = null;
let page: Page | null = null;
let authState: AuthState = 'unknown';
let authMonitorTimer: ReturnType<typeof setInterval> | null = null;

export async function launchBrowser(): Promise<Page> {
  if (page) return page;

  console.log('[Browser] Launching...');
  console.log(`[Browser] User data dir: ${USER_DATA_DIR}`);

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: process.env.HEADLESS === 'true',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  browser = context.browser();
  page = context.pages()[0] || await context.newPage();

  console.log(`[Browser] Navigating to ${CHAT_URL}...`);
  await page.goto(CHAT_URL, { waitUntil: 'networkidle' });

  const landingUrl = page.url();
  console.log(`[Browser] Landed on: ${landingUrl}`);

  authState = await checkAuth(page);
  return page;
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
    authState = await checkAuth(page!);
    if (authState === 'authenticated') return;
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
    if (!page) return;

    try {
      const previous = authState;
      authState = await checkAuth(page);

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
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
    authState = 'unknown';
  }
}

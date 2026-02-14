import { chromium, type Browser, type Page } from 'playwright';
import { resolve } from 'path';

export type AuthState = 'unknown' | 'authenticated' | 'unauthenticated';

const CHAT_URL = process.env.CHAT_URL || 'https://app.oneoption.com/chat';
const USER_DATA_DIR = process.env.USER_DATA_DIR || resolve(import.meta.dirname, '../../../data/browser-session');

let browser: Browser | null = null;
let page: Page | null = null;
let authState: AuthState = 'unknown';

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
  const today = new Date().toISOString().split('T')[0];
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

    const rememberMe = page.locator('input#RememberMe, input[name="RememberMe"]');
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

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
    authState = 'unknown';
  }
}

/**
 * Automated OneOption account rotation.
 *
 * When the current account can't access the chat room (expired trial,
 * session locked out, etc.), this module:
 *   1. Creates a new iCloud Hide My Email alias via the `hme` command
 *   2. Registers a new OneOption account in a temp Playwright browser
 *   3. Reads the verification email from iCloud via IMAP (imapflow)
 *   4. Clicks the verification link in the temp browser
 *   5. Persists the new credentials to Keychain + process.env
 *
 * Every failure sends an alert and returns null (never throws).
 * The caller falls back to waitForAuth() for manual intervention.
 */

import { chromium } from 'playwright-extra';
import type { Browser, Page } from 'playwright';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { ImapFlow } from 'imapflow';

chromium.use(StealthPlugin());
import { execFile } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sendSystemAlert } from '../lib/alert.js';
import { KeychainProvider } from '../lib/secrets/keychain-provider.js';
import { PATHS } from '../lib/paths.js';

// ─── Constants ───────────────────────────────────────

const HME_PATH = '/Users/jason/Workspace/projects/utils/hme';
const ONEOP_REGISTER_URL = 'https://app.oneoption.com/account/register';
const STORAGE_STATE_PATH = resolve(PATHS.data, 'browser-storage.json');

const IMAP_HOST = 'imap.mail.me.com';
const IMAP_PORT = 993;

const FIRST_NAMES = ['James', 'Robert', 'Michael', 'David', 'William', 'Richard', 'Joseph', 'Thomas', 'Daniel', 'Matthew', 'Sarah', 'Jennifer', 'Lisa', 'Karen', 'Emily', 'Jessica', 'Ashley', 'Amanda', 'Rachel', 'Lauren'];
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee', 'Thompson', 'White', 'Harris'];

// ─── Cooldown ────────────────────────────────────────

let lastRotationAttempt = 0;
const ROTATION_COOLDOWN_MS = 10 * 60_000; // 10 minutes

// ─── Helpers ─────────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function notify(title: string, message: string, severity: 'critical' | 'warning' | 'info' = 'critical'): void {
  sendSystemAlert({ title, message, severity });
}

// ─── Step 1: Create HME Alias ───────────────────────

async function createHmeAlias(): Promise<string> {
  const label = `oneop-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;
  console.log(`[Rotation] Creating HME alias with label: ${label}`);

  // hme uses AppleScript UI automation which requires Accessibility permissions.
  // Route through Terminal.app (which has Accessibility) to avoid permission issues
  // when the backend is spawned from a process without Accessibility access.
  const resultFile = `/tmp/hme-result-${Date.now()}.txt`;
  const doneFile = `/tmp/hme-done-${Date.now()}.txt`;

  // Try direct execution first (works if calling process has Accessibility)
  try {
    const directResult = await new Promise<string>((resolve, reject) => {
      execFile(HME_PATH, [label], { timeout: 90_000 }, (err, stdout) => {
        if (err) return reject(err);
        const email = stdout.trim();
        if (!email.includes('@')) return reject(new Error(`invalid output: ${email}`));
        resolve(email);
      });
    });
    console.log(`[Rotation] HME alias created: ${directResult}`);
    return directResult;
  } catch {
    console.log('[Rotation] Direct hme failed (no Accessibility?) — routing through Terminal.app');
  }

  // Fallback: route through Terminal.app which has Accessibility permissions
  return new Promise((resolve, reject) => {
    const cmd = `${HME_PATH} "${label}" > "${resultFile}" 2>/dev/null; echo DONE > "${doneFile}"`;
    execFile('osascript', ['-e', `tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"`],
      { timeout: 10_000 },
      (err) => { if (err) reject(new Error(`Could not open Terminal.app: ${err.message}`)); },
    );

    // Poll for result
    const deadline = Date.now() + 90_000;
    const poll = setInterval(async () => {
      try {
        const { readFileSync, unlinkSync: unlink } = await import('node:fs');
        if (existsSync(doneFile)) {
          clearInterval(poll);
          const email = readFileSync(resultFile, 'utf-8').trim();
          // Cleanup temp files
          try { unlink(resultFile); } catch {}
          try { unlink(doneFile); } catch {}

          if (!email.includes('@')) {
            return reject(new Error(`hme returned invalid output: ${email}`));
          }
          console.log(`[Rotation] HME alias created (via Terminal): ${email}`);
          resolve(email);
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          try { unlink(resultFile); } catch {}
          try { unlink(doneFile); } catch {}
          reject(new Error('hme timed out after 90s'));
        }
      } catch {
        // File not ready yet
      }
    }, 2000);
  });
}

// ─── Step 2: Register on OneOption ──────────────────

async function register(page: Page, email: string, password: string): Promise<string | null> {
  const firstName = pick(FIRST_NAMES);
  const lastName = pick(LAST_NAMES);
  console.log(`[Rotation] Registering as ${firstName} ${lastName} <${email}>`);

  await page.goto(ONEOP_REGISTER_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2000); // let reCAPTCHA/Castle/FingerprintJS load

  await page.fill('input#FirstName', firstName);
  await page.fill('input#LastName', lastName);
  await page.fill('input#Email', email);
  await page.fill('input#Password', password);
  await page.fill('input#ConfirmPassword', password);
  await page.check('#AgreeToTerms');

  // Let the page's own JS handle reCAPTCHA v3 + Castle + FingerprintJS.
  // Clicking the button (not form.submit()) triggers the page's submit handler
  // which runs all auth promises before submitting.
  await page.evaluate(() => {
    (document.querySelector('#AgreeToTerms') as HTMLInputElement).checked = true;
  });

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {}),
    page.click('input#register'),
  ]).catch(() => {});

  await page.waitForTimeout(3000);

  // Check for form errors
  const errorText = await page.evaluate(() => {
    const errors = document.querySelectorAll('.text-danger, .validation-summary-errors');
    return Array.from(errors).map(e => e.textContent?.trim()).filter(Boolean).join('; ');
  });

  if (errorText) {
    return errorText;
  }

  // If we navigated away from /register, success
  if (!page.url().includes('/register')) {
    console.log(`[Rotation] Registration succeeded — landed on ${page.url()}`);
    return null; // null = no error
  }

  return 'Registration did not navigate away from form';
}

// ─── Step 3: iCloud IMAP Verification ───────────────

/**
 * Connect to iCloud IMAP, poll for the OneOption verification email,
 * and extract the verification URL from the email body.
 */
async function findVerificationLink(targetEmail: string): Promise<string | null> {
  const icloudEmail = process.env.ICLOUD_EMAIL;
  const icloudAppPassword = process.env.ICLOUD_APP_PASSWORD;
  if (!icloudEmail || !icloudAppPassword) {
    notify('Rotation: iCloud not configured', 'ICLOUD_EMAIL or ICLOUD_APP_PASSWORD not in env');
    return null;
  }

  console.log('[Rotation] Connecting to iCloud IMAP to find verification email...');

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: icloudEmail, pass: icloudAppPassword.replace(/-/g, '') },
    logger: false,
  });

  try {
    await client.connect();

    const deadline = Date.now() + 120_000; // 2 minute timeout
    const pollInterval = 10_000; // check every 10s

    while (Date.now() < deadline) {
      const lock = await client.getMailboxLock('INBOX');
      try {
        // Search for recent emails from OneOption
        const since = new Date(Date.now() - 10 * 60_000); // last 10 minutes
        const messages = client.fetch(
          { since, from: 'oneoption' },
          { source: true },
        );

        for await (const msg of messages) {
          if (!msg.source) continue;
          const body = msg.source.toString();

          // Extract verification link from email body
          // Look for URLs containing oneoption.com with confirm/verify/Account paths
          const urlPattern = /https?:\/\/[^\s"'<>]*oneoption\.com[^\s"'<>]*(?:confirm|verify|Account\/Confirm)[^\s"'<>]*/gi;
          const matches = body.match(urlPattern);

          if (matches && matches.length > 0) {
            // Clean up URL (may have HTML entities or trailing chars)
            let link = matches[0].replace(/&amp;/g, '&').replace(/["'>].*$/, '');
            console.log(`[Rotation] Found verification link in email`);
            return link;
          }
        }
      } finally {
        lock.release();
      }

      const remaining = Math.round((deadline - Date.now()) / 1000);
      console.log(`[Rotation] No verification email yet, retrying... (${remaining}s left)`);
      await new Promise(r => setTimeout(r, pollInterval));
    }

    console.log('[Rotation] Verification email not found within timeout');
    return null;
  } finally {
    await client.logout().catch(() => {});
  }
}

// ─── Step 4: Persist Credentials ────────────────────

async function persistCredentials(email: string, password: string): Promise<void> {
  const keychain = new KeychainProvider();
  const oldEmail = process.env.ONE_OP_EMAIL;

  await keychain.set('ONE_OP_EMAIL', email);
  await keychain.set('ONE_OP_PASS', password);

  console.log(`[Rotation] Credentials persisted: ${oldEmail} → ${email}`);

  // Delete stale browser storage from old account
  if (existsSync(STORAGE_STATE_PATH)) {
    try {
      unlinkSync(STORAGE_STATE_PATH);
      console.log('[Rotation] Deleted stale browser-storage.json');
    } catch {
      // Non-fatal
    }
  }
}

// ─── Main Entry Point ───────────────────────────────

/**
 * Create a new OneOption account and persist credentials.
 * Returns the new email on success, null on failure.
 * Never throws — all failures are alerted and return null.
 */
export async function rotateAccount(): Promise<string | null> {
  // Cooldown guard
  if (Date.now() - lastRotationAttempt < ROTATION_COOLDOWN_MS) {
    const remainMin = Math.ceil((ROTATION_COOLDOWN_MS - (Date.now() - lastRotationAttempt)) / 60_000);
    console.log(`[Rotation] Cooldown active (${remainMin}m remaining) — skipping`);
    return null;
  }
  lastRotationAttempt = Date.now();

  let browser: Browser | null = null;

  try {
    notify('Account rotation started', 'Creating new OneOption account...', 'info');

    // Step 1: Create HME alias
    let email: string;
    try {
      email = await createHmeAlias();
    } catch (err) {
      notify('Rotation failed: HME', `Could not create email alias — Mac may be locked. ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    // Launch real Chrome with stealth plugin to pass bot detection
    // (reCAPTCHA v3 + Castle.js + FingerprintJS).
    browser = await chromium.launch({ channel: 'chrome', headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Step 2: Register on OneOption
    const password = `Tf${randomUUID().slice(0, 12)}!`;
    let regError: string | null;
    try {
      regError = await register(page, email, password);
    } catch (err) {
      notify('Rotation failed: registration', `OneOption registration crashed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (regError) {
      notify('Rotation failed: registration', `OneOption rejected registration: ${regError}`);
      return null;
    }

    // Step 3: Find verification email via iCloud IMAP
    let verifyLink: string | null;
    try {
      verifyLink = await findVerificationLink(email);
    } catch (err) {
      notify('Rotation failed: IMAP', `iCloud IMAP error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (!verifyLink) {
      notify('Rotation failed: verification email', `Verification email not found within 2 minutes for ${email}`);
      return null;
    }

    // Step 4: Click verification link in the browser
    try {
      console.log('[Rotation] Clicking verification link...');
      await page.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(3000);
      console.log(`[Rotation] After verification: ${page.url()}`);
    } catch (err) {
      notify('Rotation failed: verification click', `Could not open verification link: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    // Step 5: Persist credentials
    try {
      await persistCredentials(email, password);
    } catch (err) {
      notify('Rotation failed: credential persistence', `Could not save new credentials: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    notify('Account rotation complete', `New account: ${email}. Supervision loop will restart and log in.`, 'info');
    return email;
  } catch (err) {
    notify('Rotation failed: unexpected error', `${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Browser already closed
      }
    }
  }
}

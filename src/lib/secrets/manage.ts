import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as dotenv from 'dotenv';
import { PATHS } from '../paths.js';

const SERVICE = 'trade-follower';

function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

async function keychainSet(key: string, value: string): Promise<void> {
  // Delete first — keychain rejects duplicates
  try {
    await run(['delete-generic-password', '-s', SERVICE, '-a', key]);
  } catch {
    // OK if it didn't exist
  }

  await run([
    'add-generic-password',
    '-s', SERVICE,
    '-a', key,
    '-w', value,
    '-T', '/usr/bin/security', // whitelist CLI for prompt-free access
  ]);
}

async function keychainGet(key: string): Promise<string | null> {
  try {
    const { stdout } = await run(['find-generic-password', '-s', SERVICE, '-a', key, '-w']);
    return stdout.trimEnd();
  } catch {
    return null;
  }
}

async function keychainList(): Promise<void> {
  // Parse `security dump-keychain` is unreliable; instead, try reading known keys
  const envPath = PATHS.envFile;
  let keys: string[];
  try {
    const parsed = dotenv.parse(readFileSync(envPath));
    keys = Object.keys(parsed);
  } catch {
    console.error('Cannot read .env to determine key list. Provide keys manually.');
    process.exit(1);
  }

  console.log(`Checking ${keys.length} key(s) in keychain (service: ${SERVICE}):\n`);
  for (const key of keys) {
    const value = await keychainGet(key);
    const status = value !== null ? `SET (${value.length} chars)` : 'NOT FOUND';
    console.log(`  ${key.padEnd(25)} ${status}`);
  }
}

async function importFromEnv(): Promise<void> {
  const envPath = PATHS.envFile;
  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(readFileSync(envPath));
  } catch (err) {
    console.error(`Failed to read ${envPath}:`, err);
    process.exit(1);
  }

  const entries = Object.entries(parsed).filter(([, v]) => v.length > 0);
  console.log(`Importing ${entries.length} secret(s) from .env into keychain (service: ${SERVICE})...\n`);

  for (const [key, value] of entries) {
    try {
      await keychainSet(key, value);
      console.log(`  ${key.padEnd(25)} OK`);
    } catch (err) {
      console.error(`  ${key.padEnd(25)} FAILED:`, err instanceof Error ? err.message : err);
    }
  }

  console.log('\nDone.');
}

// ─── CLI ────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'import':
    importFromEnv();
    break;

  case 'set': {
    const [key, value] = args;
    if (!key || !value) {
      console.error('Usage: secrets:set <KEY> <VALUE>');
      process.exit(1);
    }
    keychainSet(key, value)
      .then(() => console.log(`Set ${key} in keychain.`))
      .catch((err) => {
        console.error('Failed:', err instanceof Error ? err.message : err);
        process.exit(1);
      });
    break;
  }

  case 'get': {
    const [key] = args;
    if (!key) {
      console.error('Usage: secrets:get <KEY>');
      process.exit(1);
    }
    keychainGet(key).then((value) => {
      if (value === null) {
        console.error(`Key "${key}" not found in keychain.`);
        process.exit(1);
      } else {
        console.log(value);
      }
    });
    break;
  }

  case 'list':
    keychainList();
    break;

  default:
    console.log('Usage: tsx src/lib/secrets/manage.ts <command>');
    console.log('');
    console.log('Commands:');
    console.log('  import          Import all keys from .env into keychain');
    console.log('  set <KEY> <VAL> Store a single key in keychain');
    console.log('  get <KEY>       Read a single key from keychain');
    console.log('  list            Show which .env keys are stored in keychain');
    process.exit(1);
}

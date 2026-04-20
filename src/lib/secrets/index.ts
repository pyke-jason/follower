import type { SecretProvider } from './types';
import { EnvProvider } from './env-provider';
import { KeychainProvider } from './keychain-provider';

export type { SecretProvider } from './types';
export { SECRET_KEYS } from './keychain-provider';

/** Get the active secret provider for CRUD operations. */
export function getProvider(): SecretProvider {
  const mode = process.env.SECRET_PROVIDER ?? 'keychain';
  if (mode === 'keychain') return new KeychainProvider();
  return new EnvProvider();
}

/**
 * Load secrets from the configured provider(s) and merge into process.env.
 *
 * Provider is selected via SECRET_PROVIDER env var:
 *   - "env"      (default) — dotenv only
 *   - "keychain" — macOS Keychain first, then dotenv fallback
 *
 * Existing process.env values are never overwritten (explicit env vars win).
 */
export async function loadSecrets(): Promise<void> {
  const mode = process.env.SECRET_PROVIDER ?? 'keychain';

  const providers: SecretProvider[] = [];

  if (mode === 'keychain') {
    providers.push(new KeychainProvider());
    providers.push(new EnvProvider()); // fallback
  } else {
    providers.push(new EnvProvider());
  }

  const merged: Record<string, string> = {};

  for (const provider of providers) {
    const secrets = await provider.load();
    for (const [key, value] of Object.entries(secrets)) {
      // Earlier providers take precedence (keychain before .env)
      if (!(key in merged)) {
        merged[key] = value;
      }
    }
  }

  let loaded = 0;
  // When ANTHROPIC_USE_SUBSCRIPTION=1, the claude-agent-sdk must route through
  // the local CLI (Max plan). Setting ANTHROPIC_API_KEY even from keychain
  // redirects the SDK to Console API billing instead. Skip it in that mode.
  const subscriptionMode = process.env.ANTHROPIC_USE_SUBSCRIPTION === '1';
  for (const [key, value] of Object.entries(merged)) {
    if (subscriptionMode && key === 'ANTHROPIC_API_KEY') continue;
    // Never overwrite explicitly set env vars
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded++;
    }
  }
  if (subscriptionMode) {
    delete process.env.ANTHROPIC_API_KEY;
  }

  console.log(`[secrets] Loaded ${loaded} secret(s) from ${providers.map((p) => p.name).join(' + ')}`);
}

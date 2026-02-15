import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as dotenv from 'dotenv';
import type { SecretProvider } from './types';

export class EnvProvider implements SecretProvider {
  readonly name = 'env';
  private path: string;

  constructor(path?: string) {
    this.path = path ?? resolve(process.cwd(), '.env');
  }

  async load(): Promise<Record<string, string>> {
    let content: string;
    try {
      content = readFileSync(this.path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw err;
    }
    return dotenv.parse(content);
  }

  async list(): Promise<string[]> {
    const secrets = await this.load();
    return Object.keys(secrets).filter((k) => secrets[k].length > 0);
  }

  async set(_key: string, _value: string): Promise<void> {
    throw new Error('EnvProvider does not support set — use keychain or edit .env manually');
  }

  async delete(_key: string): Promise<void> {
    throw new Error('EnvProvider does not support delete — use keychain or edit .env manually');
  }
}

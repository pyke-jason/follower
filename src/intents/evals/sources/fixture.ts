import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import type { EvalCase, EvalSource } from '../types.js';

class FixtureSource implements EvalSource {
  readonly name = 'fixtures';

  constructor(private readonly dir: string) {}

  async load(): Promise<EvalCase[]> {
    if (!existsSync(this.dir)) {
      return [];
    }

    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }

    const jsonFiles = entries
      .filter(f => f.endsWith('.json'))
      .sort(); // alphabetical for deterministic ordering

    const allCases: EvalCase[] = [];

    for (const filename of jsonFiles) {
      const filepath = join(this.dir, filename);
      try {
        const raw = await readFile(filepath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed != null &&
          typeof parsed === 'object' &&
          'cases' in parsed &&
          Array.isArray((parsed as { cases: unknown }).cases)
        ) {
          allCases.push(...((parsed as { cases: EvalCase[] }).cases));
        }
      } catch {
        // Skip malformed files silently
      }
    }

    return allCases;
  }
}

export function createFixtureSource(dir?: string): FixtureSource {
  const defaultDir = fileURLToPath(new URL('../fixtures', import.meta.url));
  return new FixtureSource(dir ?? defaultDir);
}

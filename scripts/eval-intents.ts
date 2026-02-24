/**
 * Intent extraction eval runner.
 *
 * Usage:
 *   npx tsx scripts/eval-intents.ts [flags]
 *
 * Flags:
 *   --source        fixtures | db | all     (default: fixtures)
 *   --fixture-dir   <path>                  (default: src/intents/evals/fixtures)
 *   --model         <model-id>              (default: claude-sonnet-4-6)
 *   --provider      anthropic | xai         (default: anthropic)
 *   --tag           <tag>                   filter cases by tag (repeatable)
 *   --case          <case-id>               run single case by ID
 *   --baseline      <json-file>             compare against saved run
 *   --output        <json-file>             save results to JSON
 *   --concurrency   <n>                     (default: 4)
 *   --version       <name>                  run a specific intent pipeline version
 *   --sweep                                 run all versions and print comparison matrix
 *   --list-versions                         list available version names and exit
 *   --help                                  print usage and exit
 */

import { loadSecrets } from '../src/lib/secrets/index.js';
import { createFixtureSource } from '../src/intents/evals/sources/fixture.js';
import { DbSource } from '../src/intents/evals/sources/db.js';
import { runEvals } from '../src/intents/evals/runner.js';
import { printReport, diffRuns } from '../src/intents/evals/reporter.js';
import { listVersions } from '../src/intents/versions.js';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { EvalRunResult, EvalSource, EvalCase } from '../src/intents/evals/types.js';

function printUsage(): void {
  console.log(`
Usage: npx tsx scripts/eval-intents.ts [flags]

Flags:
  --source         fixtures | db | all     (default: fixtures)
  --fixture-dir    <path>                  (default: src/intents/evals/fixtures)
  --model          <model-id>              (default: claude-sonnet-4-6)
  --provider       anthropic | xai         (default: anthropic)
  --tag            <tag>                   filter cases by tag (can repeat)
  --case           <case-id>               run single case by ID
  --baseline       <json-file>             compare against saved run
  --output         <json-file>             save results to JSON
  --concurrency    <n>                     parallel LLM calls (default: 4)
  --temperature    <n>                     model temperature, 0=deterministic (default: 0)
  --version        <name>                  run a specific intent pipeline version
  --sweep                                  run all versions and print comparison matrix
  --list-versions                          list available version names and exit
  --help                                   print usage and exit
`.trim());
}

interface ParsedArgs {
  source: 'fixtures' | 'db' | 'all';
  fixtureDir: string;
  model: string;
  provider: 'anthropic' | 'xai';
  tags: string[];
  caseId: string | null;
  baseline: string | null;
  output: string | null;
  concurrency: number;
  temperature: number;
  version: string | null;
  sweep: boolean;
  listVersions: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const result: ParsedArgs = {
    source: 'fixtures',
    fixtureDir: 'src/intents/evals/fixtures',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    tags: [],
    caseId: null,
    baseline: null,
    output: null,
    concurrency: 4,
    temperature: 0,
    version: null,
    sweep: false,
    listVersions: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
        result.help = true;
        break;
      case '--source': {
        const val = args[++i];
        if (val !== 'fixtures' && val !== 'db' && val !== 'all') {
          throw new Error(`--source must be one of: fixtures, db, all (got: ${val})`);
        }
        result.source = val;
        break;
      }
      case '--fixture-dir':
        result.fixtureDir = args[++i];
        break;
      case '--model':
        result.model = args[++i];
        break;
      case '--provider': {
        const val = args[++i];
        if (val !== 'anthropic' && val !== 'xai') {
          throw new Error(`--provider must be one of: anthropic, xai (got: ${val})`);
        }
        result.provider = val;
        break;
      }
      case '--tag':
        result.tags.push(args[++i]);
        break;
      case '--case':
        result.caseId = args[++i];
        break;
      case '--baseline':
        result.baseline = args[++i];
        break;
      case '--output':
        result.output = args[++i];
        break;
      case '--concurrency': {
        const n = parseInt(args[++i], 10);
        if (isNaN(n) || n < 1) throw new Error('--concurrency must be a positive integer');
        result.concurrency = n;
        break;
      }
      case '--temperature': {
        const t = parseFloat(args[++i]);
        if (isNaN(t) || t < 0 || t > 2) throw new Error('--temperature must be a number between 0 and 2');
        result.temperature = t;
        break;
      }
      case '--version':
        result.version = args[++i];
        break;
      case '--sweep':
        result.sweep = true;
        break;
      case '--list-versions':
        result.listVersions = true;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return result;
}

class CompositeSource implements EvalSource {
  readonly name: string;

  constructor(private readonly sources: EvalSource[]) {
    this.name = sources.map(s => s.name).join('+');
  }

  async load(): Promise<EvalCase[]> {
    const results = await Promise.all(this.sources.map((s) => s.load()));
    return results.flat();
  }
}

async function main(): Promise<void> {
  await loadSecrets();

  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    printUsage();
    process.exit(1);
  }

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (args.listVersions) {
    const versions = listVersions();
    console.log('Available intent pipeline versions:');
    for (const v of versions) {
      console.log(`  ${v}`);
    }
    process.exit(0);
  }

  const fixtureDir = resolve(args.fixtureDir);

  let source: EvalSource;
  switch (args.source) {
    case 'fixtures':
      source = createFixtureSource(fixtureDir);
      break;
    case 'db':
      source = new DbSource();
      break;
    case 'all':
      source = new CompositeSource([createFixtureSource(fixtureDir), new DbSource()]);
      break;
  }

  const filter =
    args.tags.length > 0 || args.caseId != null
      ? (c: EvalCase): boolean => {
          if (args.caseId != null && c.id !== args.caseId) return false;
          if (args.tags.length > 0) {
            const caseTags = c.tags ?? [];
            if (!args.tags.some((t) => caseTags.includes(t))) return false;
          }
          return true;
        }
      : undefined;

  if (args.sweep) {
    const versions = listVersions();
    console.log(`Sweeping ${versions.length} versions...\n`);

    const sweepResults: Array<{ version: string; result: EvalRunResult }> = [];
    for (const versionName of versions) {
      console.log(`--- Running ${versionName} ---`);
      const result = await runEvals(source, {
        model: args.model,
        provider: args.provider,
        concurrency: args.concurrency,
        temperature: args.temperature,
        filter,
        version: versionName,
      });
      sweepResults.push({ version: versionName, result });
    }

    // Print comparison matrix
    console.log('\n=== Sweep Results ===\n');
    const header = ['Version', 'Pass%', 'Avg Score', 'Hard Fails', 'Failures'].map(h => h.padEnd(28)).join('');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const { version, result } of sweepResults) {
      const s = result.summary;
      const row = [
        version.padEnd(28),
        `${(s.passRate * 100).toFixed(1)}%`.padEnd(28),
        s.avgScore.toFixed(3).padEnd(28),
        String(s.hardFails).padEnd(28),
        String(s.failed).padEnd(28),
      ].join('');
      console.log(row);
    }

    // Exit with failure if any version had hard fails
    const anyHardFails = sweepResults.some(r => r.result.summary.hardFails > 0);
    if (anyHardFails) process.exit(1);
    process.exit(0);
  }

  const result = await runEvals(source, {
    model: args.model,
    provider: args.provider,
    concurrency: args.concurrency,
    temperature: args.temperature,
    filter,
    ...(args.version != null ? { version: args.version } : {}),
  });

  printReport(result);

  if (args.baseline != null) {
    const baselinePath = resolve(args.baseline);
    if (!existsSync(baselinePath)) {
      console.error(`Baseline file not found: ${baselinePath}`);
      process.exit(1);
    }
    const baselineJson = await readFile(baselinePath, 'utf-8');
    const baseline = JSON.parse(baselineJson) as EvalRunResult;
    console.log(diffRuns(baseline, result));
  }

  if (args.output != null) {
    const outputPath = resolve(args.output);
    await writeFile(outputPath, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`\nResults saved to: ${outputPath}`);
  }

  if (result.summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

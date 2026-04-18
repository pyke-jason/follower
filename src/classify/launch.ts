/**
 * Classify launcher — CLI entry point.
 *
 * Two calling modes:
 *   - With a positional runId: resumes an existing classify_runs row (web UI spawn).
 *   - With <start> <end> <traders>: creates a new row and runs it (direct CLI).
 *
 * Examples:
 *   tsx src/classify/launch.ts <runId>
 *   tsx src/classify/launch.ts 2025-09-01 2025-09-02 "Dave W" --concurrency 4
 */
import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { eq } from 'drizzle-orm';
import { runClassify } from './runner.js';
import { setLogLevel, createLogger, LogLevelSchema } from '../lib/logger.js';
import { db, schema } from '../db/client.js';
import { generateRunId, assertSafeRunId, isSafeRunId } from '../lib/channel.js';
import type { ClassifyRunConfig } from '../db/schema.js';

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      'Usage:\n' +
      '  tsx src/classify/launch.ts <run-id>\n' +
      '  tsx src/classify/launch.ts <start-date> <end-date> <traders> ' +
      '[--agent-provider NAME] [--agent-model NAME] [--concurrency N] [--log-level LEVEL] [--run-id ID]',
    );
    process.exit(1);
  }

  const logLevelArg = parseArg(args, '--log-level');
  const logLevelResult = LogLevelSchema.safeParse(logLevelArg ?? 'info');
  if (!logLevelResult.success) {
    console.error(`Invalid log level "${logLevelArg}". Must be one of: debug, info, warn, error`);
    process.exit(1);
  }
  setLogLevel(logLevelResult.data);
  const log = createLogger('ClassifyLaunch');

  let runId: string;
  let config: ClassifyRunConfig;

  // Resume mode: single positional that's already a runId in classify_runs
  if (args.length === 1 && !args[0].startsWith('--') && isSafeRunId(args[0])) {
    runId = args[0];
    const [existing] = await db.select({ config: schema.classifyRuns.config })
      .from(schema.classifyRuns)
      .where(eq(schema.classifyRuns.id, runId));
    if (!existing) {
      console.error(`classify_runs row not found for id ${runId}`);
      process.exit(1);
    }
    config = existing.config;
  } else {
    if (args.length < 3) {
      console.error(
        'Usage: tsx src/classify/launch.ts <start-date> <end-date> <traders> [options]',
      );
      process.exit(1);
    }
    const startDate = new Date(args[0] + 'T00:00:00Z');
    const endDate = new Date(args[1] + 'T23:59:59Z');
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      console.error('Invalid date format. Use YYYY-MM-DD.');
      process.exit(1);
    }
    const traders = args[2].split(',').map((t) => t.trim()).filter(Boolean);
    if (traders.length === 0) {
      console.error('At least one trader is required.');
      process.exit(1);
    }
    const concurrencyArg = parseArg(args, '--concurrency');
    const maxAgentCallsArg = parseArg(args, '--max-agent-calls');

    config = {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      traders,
      agentProvider: parseArg(args, '--agent-provider'),
      agentModel: parseArg(args, '--agent-model'),
      concurrency: concurrencyArg ? parseInt(concurrencyArg, 10) : undefined,
      maxAgentCalls: maxAgentCallsArg ? parseInt(maxAgentCallsArg, 10) : undefined,
    };

    const explicitRunId = parseArg(args, '--run-id');
    if (explicitRunId) {
      assertSafeRunId(explicitRunId);
      runId = explicitRunId;
      const [existing] = await db.select({ id: schema.classifyRuns.id })
        .from(schema.classifyRuns)
        .where(eq(schema.classifyRuns.id, runId));
      if (!existing) {
        await db.insert(schema.classifyRuns).values({
          id: runId,
          status: 'PENDING',
          config,
        });
      }
    } else {
      runId = generateRunId();
      await db.insert(schema.classifyRuns).values({
        id: runId,
        status: 'PENDING',
        config,
      });
    }
  }

  log.info(`Starting classify run ${runId}...`);
  const t0 = Date.now();
  const report = await runClassify(config, runId);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log.info(`Completed in ${elapsed}s — ${JSON.stringify(report.summary)}`);
}

process.on('SIGTERM', () => {
  createLogger('ClassifyLaunch').info('Received SIGTERM, exiting.');
  process.exit(0);
});

main().catch((err) => {
  createLogger('ClassifyLaunch').error('Fatal error:', err);
  process.exit(1);
});

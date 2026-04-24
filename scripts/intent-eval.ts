import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { loadSecrets } from '../src/lib/secrets/index.js';
import { createArtifact, readJsonArtifact, writeJsonArtifact } from '../src/intents/evals/artifacts.js';
import { runFixtureEvalSuite } from '../src/intents/evals/fixture-runner.js';
import { diffRuns, printReport } from '../src/intents/evals/reporter.js';
import {
  diffReplayRuns,
  exportReplayCorpus,
  printReplayDiff,
  printReplayReport,
  runReplay,
  type CohortName,
} from '../src/intents/evals/replay.js';
import type {
  EvalRunResult,
  IntentEvalArtifact,
  ReplayCorpus,
  ReplayDiffResult,
  ReplayRunResult,
} from '../src/intents/evals/types.js';
import type { ModelProvider } from '../src/agent/result.js';

const command = process.argv[2];

switch (command) {
  case 'fixtures':
    await fixturesCommand(process.argv.slice(3));
    break;
  case 'export-cohort':
    await exportCohortCommand(process.argv.slice(3));
    break;
  case 'replay':
    await replayCommand(process.argv.slice(3));
    break;
  case 'diff':
    await diffCommand(process.argv.slice(3));
    break;
  case 'report':
    await reportCommand(process.argv.slice(3));
    break;
  default:
    usage();
    process.exit(command == null ? 0 : 1);
}

async function fixturesCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      tag: { type: 'string' },
      case: { type: 'string' },
      provider: { type: 'string', default: 'xai' },
      model: { type: 'string', default: 'grok-4-1-fast-non-reasoning' },
      concurrency: { type: 'string', default: '8' },
      out: { type: 'string' },
      baseline: { type: 'string' },
      'allow-failures': { type: 'boolean', default: false },
    },
    strict: false,
  });

  await loadSecrets();
  const provider = values.provider as ModelProvider;
  const model = values.model!;
  const run = await runFixtureEvalSuite({
    provider,
    model,
    tag: values.tag,
    caseId: values.case,
    concurrency: Number.parseInt(values.concurrency!, 10),
    logProgress: true,
  });

  printReport(run);
  let baseline: EvalRunResult | null = null;
  if (values.baseline) {
    baseline = await readArtifactPayload<EvalRunResult>(values.baseline, 'fixtures');
    console.log(diffRuns(baseline, run));
  }

  if (values.out) {
    const artifact = createArtifact({
      kind: 'fixtures',
      provider,
      model,
      baselineArtifact: values.baseline ?? null,
      payload: run,
    });
    await writeJsonArtifact(values.out, artifact);
    console.log(`\nWrote fixture artifact: ${resolve(values.out)}`);
  }

  const regressions = baseline ? countFixtureRegressions(baseline, run) : 0;
  const passRateDrop = baseline ? run.summary.passRate < baseline.summary.passRate : false;
  if (
    !values['allow-failures'] &&
    (run.summary.failed > 0 || run.summary.hardFails > 0 || regressions > 0 || passRateDrop)
  ) {
    process.exit(1);
  }
}

async function exportCohortCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      corpus: { type: 'string' },
      'database-url': { type: 'string' },
      model: { type: 'string' },
      limit: { type: 'string', default: '250' },
      out: { type: 'string' },
    },
    strict: false,
  });

  await loadSecrets();
  const corpusName = requireCohort(values.corpus);
  const corpus = await exportReplayCorpus({
    databaseUrl: values['database-url'],
    corpus: corpusName,
    model: values.model,
    limit: Number.parseInt(values.limit!, 10),
  });
  const artifact = createArtifact({ kind: 'cohort', payload: corpus });
  const out = values.out ?? `artifacts/intent-eval/${corpusName}-${Date.now()}.json`;
  await writeJsonArtifact(out, artifact);
  console.log(`Exported ${corpus.messages.length} messages to ${resolve(out)}`);
}

async function replayCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      corpus: { type: 'string' },
      provider: { type: 'string', default: 'xai' },
      model: { type: 'string', default: 'grok-4-1-fast-non-reasoning' },
      concurrency: { type: 'string', default: '8' },
      out: { type: 'string' },
    },
    strict: false,
  });

  if (!values.corpus) throw new Error('--corpus is required');
  await loadSecrets();
  const corpus = await readArtifactPayload<ReplayCorpus>(values.corpus, 'cohort');
  const provider = values.provider as ModelProvider;
  const model = values.model!;
  const run = await runReplay({
    corpus,
    provider,
    model,
    concurrency: Number.parseInt(values.concurrency!, 10),
    logProgress: true,
  });
  printReplayReport(run);

  if (values.out) {
    const artifact = createArtifact({
      kind: 'replay',
      provider,
      model,
      payload: run,
    });
    await writeJsonArtifact(values.out, artifact);
    console.log(`\nWrote replay artifact: ${resolve(values.out)}`);
  }
}

async function diffCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      out: { type: 'string' },
      'allow-regressions': { type: 'boolean', default: false },
    },
    strict: false,
  });

  if (!values.baseline) throw new Error('--baseline is required');
  if (!values.candidate) throw new Error('--candidate is required');
  const baseline = await readArtifactPayload<ReplayRunResult>(values.baseline, 'replay');
  const candidate = await readArtifactPayload<ReplayRunResult>(values.candidate, 'replay');
  const diff = diffReplayRuns(baseline, candidate);
  printReplayDiff(diff);

  if (values.out) {
    const artifact = createArtifact({
      kind: 'diff',
      baselineArtifact: values.baseline,
      payload: diff,
    });
    await writeJsonArtifact(values.out, artifact);
    console.log(`\nWrote diff artifact: ${resolve(values.out)}`);
  }

  if (!values['allow-regressions'] && diff.regressions.length > 0) {
    process.exit(1);
  }
}

async function reportCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      artifact: { type: 'string' },
    },
    strict: false,
  });
  if (!values.artifact) throw new Error('--artifact is required');

  const artifact = await readJsonArtifact<IntentEvalArtifact>(values.artifact);
  if (artifact.kind === 'fixtures') {
    printReport(artifact.payload as EvalRunResult);
  } else if (artifact.kind === 'replay') {
    printReplayReport(artifact.payload as ReplayRunResult);
  } else if (artifact.kind === 'diff') {
    printReplayDiff(artifact.payload as ReplayDiffResult);
  } else if (artifact.kind === 'cohort') {
    const corpus = artifact.payload as ReplayCorpus;
    console.log(`Cohort ${corpus.name}: ${corpus.messages.length} messages exported ${corpus.exportedAt}`);
  } else {
    throw new Error(`Unsupported artifact kind: ${String(artifact.kind)}`);
  }
}

async function readArtifactPayload<T>(
  path: string,
  expectedKind: IntentEvalArtifact['kind'],
): Promise<T> {
  const raw = await readJsonArtifact<IntentEvalArtifact | T>(path);
  if (isArtifact(raw)) {
    if (raw.kind !== expectedKind) {
      throw new Error(`Expected ${expectedKind} artifact, got ${raw.kind}`);
    }
    return raw.payload as T;
  }
  return raw as T;
}

function isArtifact(value: unknown): value is IntentEvalArtifact {
  return (
    value != null &&
    typeof value === 'object' &&
    'artifactVersion' in value &&
    'kind' in value &&
    'payload' in value
  );
}

function countFixtureRegressions(baseline: EvalRunResult, current: EvalRunResult): number {
  const baseById = new Map(baseline.cases.map((c) => [c.caseId, c]));
  let count = 0;
  for (const curr of current.cases) {
    const base = baseById.get(curr.caseId);
    if (base?.passed && !curr.passed) count++;
  }
  return count;
}

function requireCohort(value: string | undefined): CohortName {
  if (
    value === 'commentary-skip' ||
    value === 'simple-structured-exec' ||
    value === 'exit-loop'
  ) {
    return value;
  }
  throw new Error('--corpus must be one of commentary-skip, simple-structured-exec, exit-loop');
}

function usage(): void {
  console.log(`Usage:
  npx tsx scripts/intent-eval.ts fixtures [--provider xai] [--model MODEL] [--tag TAG] [--case ID] [--out PATH] [--baseline PATH]
  npx tsx scripts/intent-eval.ts export-cohort --corpus commentary-skip|simple-structured-exec|exit-loop [--out PATH]
  npx tsx scripts/intent-eval.ts replay --corpus PATH [--provider xai] [--model MODEL] [--out PATH]
  npx tsx scripts/intent-eval.ts diff --baseline PATH --candidate PATH [--out PATH]
  npx tsx scripts/intent-eval.ts report --artifact PATH`);
}

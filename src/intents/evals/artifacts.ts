import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IntentEvalArtifact, IntentEvalArtifactKind } from './types.js';
import { INTENT_VERSION } from '../orchestrator/intent-cache.js';

export function createArtifact<TKind extends IntentEvalArtifactKind, TPayload>(params: {
  kind: TKind;
  payload: TPayload;
  provider?: string;
  model?: string;
  baselineArtifact?: string | null;
}): IntentEvalArtifact<TKind, TPayload> {
  return {
    artifactVersion: 1,
    kind: params.kind,
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    provider: params.provider,
    model: params.model,
    intentVersion: INTENT_VERSION,
    baselineArtifact: params.baselineArtifact ?? null,
    payload: params.payload,
  };
}

export async function writeJsonArtifact(path: string, artifact: unknown): Promise<void> {
  const out = resolve(path);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
}

export async function readJsonArtifact<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), 'utf-8');
  return JSON.parse(raw) as T;
}

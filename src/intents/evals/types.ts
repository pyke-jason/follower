// All shared types for the eval system.

import type { DecisionOutcome } from '@/lib/enums.js';
import type { OptionLeg, ResolvedSignal, TradePosition } from '../orchestrator/types.js';
import type { Signal } from '@/agent/schemas.js';

export type EvalChatHistoryMessage = {
  rawHtml: string;
  author?: string;
  timestamp?: string;
};

export type EvalInput = {
  rawHtml: string;
  author?: string;       // default 'testTrader'
  timestamp?: string;    // ISO 8601, default '2025-09-05T14:00:00.000Z'
  positions?: TradePosition[];
  chatHistory?: EvalChatHistoryMessage[]; // structured recent messages for get_recent_chat parity
};

export type ExpectedLeg = Partial<Pick<OptionLeg, 'side' | 'strike' | 'optionType' | 'expiry'>>;

export type ExpectedSignal = {
  orderType?: ResolvedSignal['orderType'];
  exitPercent?: number;
  legs?: ExpectedLeg[];
  symbol?: string;       // verify correct underlying in multi-ticker messages
};

export type EvalCase = {
  id: string;
  description: string;
  input: EvalInput;
  expected: {
    outcome: DecisionOutcome;
    signals?: ExpectedSignal[];
  };
  /** Field paths that cause hard FAIL if mismatched. e.g. ['signals[0].orderType', 'signals[0].legs[0].side'] */
  mustMatch?: string[];
  tags?: string[];
  notes?: string;
};

export type EvalSource = {
  name: string;
  load(): Promise<EvalCase[]>;
};

export type FieldScore = {
  field: string;
  matched: boolean;
  expected: unknown;
  actual: unknown;
};

export type EvalResult = {
  caseId: string;
  description: string;
  passed: boolean;     // !hardFail && score >= PASS_THRESHOLD
  hardFail: boolean;   // any mustMatch field mismatched
  score: number;       // 0..1
  fieldScores: FieldScore[];
  hardFailFields: string[];
  actualDecision: string;
  expectedDecision: string;
  actualSignals: unknown[];
  error?: string;
  durationMs: number;
  tags: string[];
};

export type EvalRunResult = {
  runId: string;
  promptHash: string;   // SHA256 of INTENT_SYSTEM_PROMPT
  model: string;
  provider: string;
  timestamp: string;    // ISO 8601
  source: string;       // source name(s)
  cases: EvalResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    hardFails: number;
    passRate: number;
    avgScore: number;
    byTag: Record<string, { total: number; passed: number; passRate: number }>;
  };
};

export type IntentEvalArtifactKind = 'fixtures' | 'cohort' | 'replay' | 'diff';

export type IntentEvalArtifact<TKind extends IntentEvalArtifactKind = IntentEvalArtifactKind, TPayload = unknown> = {
  artifactVersion: 1;
  kind: TKind;
  runId: string;
  timestamp: string;
  provider?: string;
  model?: string;
  intentVersion?: number;
  baselineArtifact?: string | null;
  payload: TPayload;
};

export type ReplayCorpusMessage = {
  messageId: string;
  author: string;
  timestamp: string;
  rawHtml: string;
  cleanText: string;
  badges: string[];
  symbols: string[];
  history: EvalChatHistoryMessage[];
  oracle?: {
    outcome: DecisionOutcome | 'ERROR';
    classifierSignals: Signal[];
    route?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadInputTokens?: number | null;
    cacheCreationInputTokens?: number | null;
    costUsd?: number | null;
    turns?: number | null;
  };
};

export type ReplayCorpus = {
  name: string;
  exportedAt: string;
  query: string;
  messages: ReplayCorpusMessage[];
};

export type ReplayResult = {
  messageId: string;
  outcome: DecisionOutcome | 'ERROR';
  route: 'hard-skip' | 'deterministic' | 'llm' | 'error';
  ruleId: string | null;
  routeReason: string | null;
  classifierSignals: Signal[];
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  error?: string;
};

export type ReplayRunResult = {
  runId: string;
  provider: string;
  model: string;
  timestamp: string;
  corpusName: string;
  results: ReplayResult[];
  summary: {
    total: number;
    byOutcome: Record<string, number>;
    byRoute: Record<string, number>;
    byRuleId: Record<string, number>;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadInputTokens: number;
    totalCacheCreationInputTokens: number;
    totalCostUsd: number;
  };
};

export type ReplayMismatch = {
  messageId: string;
  field: string;
  expected: unknown;
  actual: unknown;
};

export type ReplayDiffResult = {
  baselineRunId: string;
  candidateRunId: string;
  timestamp: string;
  totalCompared: number;
  regressions: ReplayMismatch[];
  routeDeltas: Record<string, number>;
  costDeltaUsd: number;
  llmCallDelta: number;
};

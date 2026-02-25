// All shared types for the eval system.

import type { OptionLeg, ResolvedSignal, OpenPosition } from '../orchestrator/types.js';

export type EvalInput = {
  rawHtml: string;
  author?: string;       // default 'testTrader'
  timestamp?: string;    // ISO 8601, default '2025-09-05T14:00:00.000Z'
  positions?: OpenPosition[];
  chatContext?: string;   // recent messages for LLM context in relational cases
};

export type ExpectedLeg = Partial<Pick<OptionLeg, 'side' | 'strike' | 'optionType' | 'expiry'>>;

export type ExpectedSignal = {
  orderType?: ResolvedSignal['orderType'];
  exitPercent?: number;
  hasTradeId?: boolean;
  legs?: ExpectedLeg[];
  symbol?: string;       // verify correct underlying in multi-ticker messages
};

export type EvalCase = {
  id: string;
  description: string;
  input: EvalInput;
  expected: {
    outcome: 'EXECUTE' | 'SKIP' | 'MANUAL_REVIEW';
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

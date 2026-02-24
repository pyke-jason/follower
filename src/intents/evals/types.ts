// All shared types for the eval system.

export type EvalCaseInput = {
  message: string;
  author?: string;       // default 'testTrader'
  timestamp?: string;    // ISO 8601, default '2025-09-05T14:00:00.000Z'
  badges?: string[];
  symbols?: string[];
};

export type ExpectedSignal = {
  action: 'OPEN' | 'CLOSE' | 'ADD' | 'TRIM' | 'LEG_OFF';
  symbol?: string;
  direction?: 'LONG' | 'SHORT';
  strategy?: 'STOCK' | 'CALL' | 'PUT' | 'CDS' | 'PDS';
  exitPercent?: number;
  targetStrategy?: 'CALL' | 'PUT';
  statedPremium?: number;
  legs?: Array<{
    strike?: number;
    expiry?: string;      // raw text, 'YYYY-MM-DD', or 'LEAP' (special: means >= 6 months from refDate)
    optionType?: 'CALL' | 'PUT';
    action?: 'BUY' | 'SELL';
  }>;
};

export type EvalCase = {
  id: string;
  description: string;
  input: EvalCaseInput;
  expected: {
    decision: 'EXECUTE' | 'SKIP' | 'MANUAL_REVIEW';
    signals?: ExpectedSignal[];
  };
  /** Field paths that cause hard FAIL if mismatched. e.g. ['signals[0].direction', 'signals[0].strategy'] */
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

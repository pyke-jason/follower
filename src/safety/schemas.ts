import { z } from 'zod';
import { SignalSchema } from '../agent/schemas.js';
import {
  OrchestratorResultSchema,
  ResolvedSignalSchema,
  SerializedParseResultSchema,
} from '../intents/orchestrator/types.js';

export const SafetySeveritySchema = z.enum(['critical', 'warning', 'info']);
export type SafetySeverity = z.infer<typeof SafetySeveritySchema>;

export const SafetyFindingCategorySchema = z.enum([
  'stock_options_mismatch',
  'sell_to_open_direction_mismatch',
  'pnl_percent_as_trim_size',
  'hallucinated_strike',
  'missing_stated_price',
  'ambiguous_exit_target',
  'unsupported_short_option_risk',
  'profit_loss_mismatch',
  'scratch_mismatch',
  'suspicious_skip',
  'future_conditional_executed',
  'multi_trade_malformed',
  'critic_error',
]);
export type SafetyFindingCategory = z.infer<typeof SafetyFindingCategorySchema>;

export const SafetyFindingSchema = z.object({
  category: SafetyFindingCategorySchema,
  severity: SafetySeveritySchema,
  message: z.string().min(1),
  evidence: z.string().min(1),
  signalIndex: z.number().int().nonnegative().optional(),
  field: z.string().optional(),
  confidence: z.number().min(0).max(1),
});
export type SafetyFinding = z.infer<typeof SafetyFindingSchema>;

export const SafetyGateModeSchema = z.enum(['shadow', 'block']);
export type SafetyGateMode = z.infer<typeof SafetyGateModeSchema>;

export const ClassificationGateResultSchema = z.object({
  mode: SafetyGateModeSchema,
  decision: z.enum(['allow', 'block']),
  severity: SafetySeveritySchema,
  reason: z.string(),
  findings: z.array(SafetyFindingSchema),
});
export type ClassificationGateResult = z.infer<typeof ClassificationGateResultSchema>;

export const CriticVerdictSchema = z.object({
  verdict: z.enum(['ok', 'warning', 'critical']),
  summary: z.string().min(1),
  findings: z.array(SafetyFindingSchema).max(5),
});
export type CriticVerdict = z.infer<typeof CriticVerdictSchema>;

export const ClassificationRunDecisionSnapshotSchema = z.object({
  parseResult: SerializedParseResultSchema.optional(),
  route: z.enum(['deterministic', 'llm', 'hard-skip']).optional(),
  resolved: OrchestratorResultSchema.optional(),
  retryResolved: OrchestratorResultSchema.optional(),
  signal: ResolvedSignalSchema.optional(),
  gate: ClassificationGateResultSchema.optional(),
}).passthrough().nullable();
export type ClassificationRunDecisionSnapshot = z.infer<typeof ClassificationRunDecisionSnapshotSchema>;

export const ClassificationAuditDecisionContextSchema = z.object({
  snapshot: ClassificationRunDecisionSnapshotSchema,
}).transform(({ snapshot }) => {
  let resolved: z.infer<typeof OrchestratorResultSchema> | null = null;
  if (snapshot && snapshot.resolved) {
    resolved = snapshot.resolved;
  } else if (snapshot && snapshot.retryResolved) {
    resolved = snapshot.retryResolved;
  }

  let parseResult: z.infer<typeof SerializedParseResultSchema> | null = null;
  if (snapshot && snapshot.parseResult) {
    parseResult = snapshot.parseResult;
  } else if (resolved && resolved.parseResult) {
    parseResult = resolved.parseResult;
  }

  return {
    snapshot,
    resolved,
    route: parseResult ? parseResult.routeReason : null,
    signals: resolved && resolved.classifierSignals ? resolved.classifierSignals : null,
  };
});
export type ClassificationAuditDecisionContext = z.infer<typeof ClassificationAuditDecisionContextSchema>;

export const ClassificationAuditKindSchema = z.enum(['gate', 'postmortem']);
export type ClassificationAuditKind = z.infer<typeof ClassificationAuditKindSchema>;

export const ClassificationAuditStatusSchema = z.enum(['open', 'resolved', 'dismissed']);
export type ClassificationAuditStatus = z.infer<typeof ClassificationAuditStatusSchema>;

export const ClassificationAuditPayloadSchema = z.object({
  message: z.object({
    id: z.string(),
    author: z.string(),
    timestamp: z.string(),
    cleanText: z.string(),
    badges: z.array(z.string()),
    symbols: z.array(z.string()),
  }),
  classifier: z.object({
    provider: z.string().nullable(),
    model: z.string().nullable(),
    outcome: z.string().nullable(),
    reasoning: z.string().nullable(),
    route: z.string().nullable(),
    signals: z.array(SignalSchema).nullable(),
    resolved: OrchestratorResultSchema.optional(),
  }),
  execution: z.object({
    runDecisionId: z.string().nullable(),
    tradeId: z.string().nullable(),
    signalIndex: z.number().int().nullable(),
    snapshot: z.unknown().nullable(),
  }),
  gate: ClassificationGateResultSchema.nullable(),
  critic: CriticVerdictSchema.nullable(),
});
export type ClassificationAuditPayload = z.infer<typeof ClassificationAuditPayloadSchema>;

export const ClassificationAuditSummarySchema = z.object({
  findings: z.array(SafetyFindingSchema),
  critic: CriticVerdictSchema.nullable(),
}).transform(({ findings, critic }) => {
  const severityRank: Record<SafetySeverity, number> = { critical: 3, warning: 2, info: 1 };
  const [primary] = [...findings].sort((a, b) =>
    severityRank[b.severity] - severityRank[a.severity] ||
    b.confidence - a.confidence,
  );

  if (primary) {
    return {
      severity: primary.severity,
      status: primary.severity === 'info' ? 'resolved' as const : 'open' as const,
      confidence: primary.confidence,
      category: primary.category,
      title: primary.message,
      details: primary.evidence,
    };
  }

  if (critic && critic.verdict !== 'ok') {
    return {
      severity: critic.verdict,
      status: 'open' as const,
      confidence: 0,
      category: null,
      title: critic.summary,
      details: critic.summary,
    };
  }

  return {
    severity: 'info' as const,
    status: 'resolved' as const,
    confidence: 0,
    category: null,
    title: 'No audit findings',
    details: 'No deterministic or critic findings.',
  };
});
export type ClassificationAuditSummary = z.infer<typeof ClassificationAuditSummarySchema>;

export const ClassificationAuditRowSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  taskId: z.string().nullable(),
  messageId: z.string(),
  runDecisionId: z.string().nullable(),
  auditKind: ClassificationAuditKindSchema,
  severity: SafetySeveritySchema,
  status: ClassificationAuditStatusSchema,
  confidence: z.number(),
  category: SafetyFindingCategorySchema.nullable(),
  title: z.string(),
  details: z.string(),
  findings: z.array(SafetyFindingSchema),
  payload: ClassificationAuditPayloadSchema,
  critic: CriticVerdictSchema.nullable(),
  alertKey: z.string().nullable(),
  alertSentAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolvedReason: z.string().nullable(),
  createdAt: z.string(),
});
export type ClassificationAuditRow = z.infer<typeof ClassificationAuditRowSchema>;

export const ClassificationAuditListResponseSchema = z.object({
  rows: z.array(ClassificationAuditRowSchema),
  total: z.number().int().nonnegative(),
});
export type ClassificationAuditListResponse = z.infer<typeof ClassificationAuditListResponseSchema>;

export const ClassificationAuditStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  critical: z.number().int().nonnegative(),
  warning: z.number().int().nonnegative(),
  byCategory: z.record(z.string(), z.number().int().nonnegative()),
});
export type ClassificationAuditStats = z.infer<typeof ClassificationAuditStatsSchema>;

export const ClassificationAuditResolveBodySchema = z.object({
  status: z.enum(['resolved', 'dismissed']),
  reason: z.string().trim().min(1).optional(),
});
export type ClassificationAuditResolveBody = z.infer<typeof ClassificationAuditResolveBodySchema>;

export const ClassificationAuditIdParamsSchema = z.object({
  id: z.string().min(1),
});
export type ClassificationAuditIdParams = z.infer<typeof ClassificationAuditIdParamsSchema>;

export const ClassificationAuditListQuerySchema = z.object({
  status: ClassificationAuditStatusSchema.default('open'),
  severity: SafetySeveritySchema.optional(),
  channel: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type ClassificationAuditListQuery = z.infer<typeof ClassificationAuditListQuerySchema>;

export const ClassificationGateInputSchema = z.object({
  messageText: z.string(),
  badges: z.array(z.string()),
  symbols: z.array(z.string()),
  classifierSignals: z.array(SignalSchema),
  resolvedSignals: z.array(ResolvedSignalSchema),
});
export type ClassificationGateInput = z.infer<typeof ClassificationGateInputSchema>;

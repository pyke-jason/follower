import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db, schema } from '@/db/client.js';
import type { Agent } from '@/agent/result.js';
import type { Message, RunDecision, Task } from '@/db/schema.js';
import type { ClassificationGateResult, SafetyFinding } from './schemas.js';
import {
  ClassificationAuditDecisionContextSchema,
  ClassificationAuditPayloadSchema,
  ClassificationAuditRowSchema,
  ClassificationAuditSummarySchema,
  CriticVerdictSchema,
  SafetyFindingSchema,
  type ClassificationAuditDecisionContext,
  type ClassificationAuditPayload,
  type CriticVerdict,
  type SafetyFindingCategory,
  type SafetySeverity,
} from './schemas.js';
import { runClassificationCritic } from './classification-critic.js';

const PROFIT_RE = /\b(?:profit|profits|gain|gains|green|winner)\b/i;
const LOSS_RE = /\b(?:loss|losses|stopped|stop(?:ped)?\s*out|cut|red)\b/i;
const SCRATCH_RE = /\b(?:scratch|breakeven|break\s*even|flat)\b/i;
const EXIT_RE = /\b(?:exit|closed?|trim(?:med)?|sold|took|all\s+out|half\s+out|stop(?:ped)?\s*out|cut)\b/i;
const CONDITIONAL_RE = /\b(?:will|going\s+to|looking\s+to|trying\s+to|hoping\s+to|plan\s+to|might|thinking\s+about|if\s+)\b/i;
const SCRATCH_MATERIAL_PNL = 25;

type AuditInput = {
  message: Message;
  task: Task;
  runDecision: RunDecision;
  agent: Agent;
  gateResult: ClassificationGateResult | null;
  sendAlert?: (params: { title: string; message: string; severity: 'critical' | 'warning' | 'info' }) => Promise<void> | void;
};

export function enqueueClassificationAudit(input: AuditInput): void {
  if (process.env.CLASSIFICATION_AUDIT_ENABLED === '0') return;
  void recordClassificationAudit(input).catch((err) => {
    console.warn('[ClassificationAudit] failed:', err);
  });
}

export async function recordClassificationAudit(input: AuditInput): Promise<void> {
  const decisionContext = ClassificationAuditDecisionContextSchema.parse({
    snapshot: input.runDecision.snapshot,
  });
  const gateFindings = input.gateResult === null ? [] : input.gateResult.findings;
  const deterministicFindings = [
    ...gateFindings,
    ...await buildPostmortemFindings(input, decisionContext),
  ].map((finding) => SafetyFindingSchema.parse(finding));

  const basePayload = await buildAuditPayload(input, decisionContext, null);
  const critic = await maybeRunCritic(input.agent, basePayload);
  const criticFindings = critic === null ? [] : critic.findings;
  const allFindings = [
    ...deterministicFindings,
    ...criticFindings,
  ].map((finding) => SafetyFindingSchema.parse(finding));

  const payload = ClassificationAuditPayloadSchema.parse({
    ...basePayload,
    critic,
  });

  const summary = ClassificationAuditSummarySchema.parse({ findings: allFindings, critic });
  const alertKey = summary.severity === 'critical' && summary.category
    ? `${input.message.id}:${summary.category}`
    : null;

  const [row] = await db.insert(schema.classificationAudits)
    .values({
      channelId: input.runDecision.channelId,
      taskId: input.task.id,
      messageId: input.message.id,
      runDecisionId: input.runDecision.id,
      auditKind: 'postmortem',
      severity: summary.severity,
      status: summary.status,
      confidence: summary.confidence,
      category: summary.category,
      title: summary.title,
      details: summary.details,
      findings: allFindings,
      payload,
      critic,
      alertKey,
    })
    .returning();

  const parsed = ClassificationAuditRowSchema.parse(row);
  if (parsed.severity === 'critical' && parsed.status === 'open') {
    await pageCriticalOnce(parsed.id, parsed.alertKey, input.sendAlert);
  }
}

async function buildAuditPayload(
  input: AuditInput,
  decisionContext: ClassificationAuditDecisionContext,
  critic: CriticVerdict | null,
): Promise<ClassificationAuditPayload> {
  return ClassificationAuditPayloadSchema.parse({
    message: {
      id: input.message.id,
      author: input.message.author,
      timestamp: input.message.timestamp,
      cleanText: input.message.cleanText,
      badges: input.message.badges,
      symbols: input.message.symbols,
    },
    classifier: {
      provider: input.task.modelProvider,
      model: input.task.modelName,
      outcome: input.runDecision.outcome,
      reasoning: input.runDecision.reasoning,
      route: decisionContext.route,
      signals: decisionContext.signals,
      ...(decisionContext.resolved ? { resolved: decisionContext.resolved } : {}),
    },
    execution: {
      runDecisionId: input.runDecision.id,
      tradeId: input.runDecision.tradeId,
      signalIndex: input.runDecision.signalIndex,
      snapshot: decisionContext.snapshot,
    },
    gate: input.gateResult,
    critic,
  });
}

async function maybeRunCritic(agent: Agent, payload: ClassificationAuditPayload): Promise<CriticVerdict | null> {
  if (process.env.CLASSIFICATION_CRITIC_ENABLED === '0') return null;
  try {
    const result = await runClassificationCritic({ agent, payload });
    return CriticVerdictSchema.parse(result.verdict);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      verdict: 'warning',
      summary: `Classification critic failed: ${message}`,
      findings: [{
        category: 'critic_error',
        severity: 'warning',
        message: 'Classification critic failed.',
        evidence: message.slice(0, 500),
        confidence: 0.5,
      }],
    };
  }
}

async function buildPostmortemFindings(
  input: AuditInput,
  decisionContext: ClassificationAuditDecisionContext,
): Promise<SafetyFinding[]> {
  const findings: SafetyFinding[] = [];
  const text = input.message.cleanText;
  const pnl = await readDecisionPnl(input.runDecision);

  if (pnl != null) {
    if (PROFIT_RE.test(text) && pnl < 0) {
      findings.push(finding('profit_loss_mismatch', 'critical', 'Message says profit/gain, but realized P&L is negative.', `pnl=${pnl}; text="${clip(text)}"`, 0.96));
    }
    if (LOSS_RE.test(text) && pnl > SCRATCH_MATERIAL_PNL) {
      findings.push(finding('profit_loss_mismatch', 'critical', 'Message says loss/stop/cut, but realized P&L is materially positive.', `pnl=${pnl}; text="${clip(text)}"`, 0.88));
    }
    if (SCRATCH_RE.test(text) && Math.abs(pnl) > SCRATCH_MATERIAL_PNL) {
      findings.push(finding('scratch_mismatch', 'critical', 'Message says scratch/flat, but realized P&L is material.', `pnl=${pnl}; threshold=${SCRATCH_MATERIAL_PNL}`, 0.9));
    }
  }

  if (input.runDecision.outcome === 'SKIP' && EXIT_RE.test(text) && input.message.symbols.length > 0) {
    const openTrades = await db.select({ id: schema.trades.id, symbol: schema.trades.symbol })
      .from(schema.trades)
      .where(and(
        eq(schema.trades.channelId, input.runDecision.channelId),
        eq(schema.trades.trader, input.message.author),
        inArray(schema.trades.symbol, input.message.symbols),
        eq(schema.trades.status, 'OPEN'),
      ))
      .limit(5);
    if (openTrades.length > 0) {
      findings.push(finding(
        'suspicious_skip',
        'critical',
        'Skipped message looks like an exit/update on an open position.',
        `open=${openTrades.map((trade) => `${trade.symbol}:${trade.id.slice(0, 8)}`).join(', ')}; text="${clip(text)}"`,
        0.83,
      ));
    }
  }

  if (input.runDecision.outcome === 'EXECUTE' && CONDITIONAL_RE.test(text)) {
    findings.push(finding('future_conditional_executed', 'warning', 'Executed message contains future or conditional language.', clip(text), 0.72));
  }

  const signals = decisionContext.signals === null ? [] : decisionContext.signals;
  if (input.message.symbols.length > 1 && /\band\b|,/i.test(text) && signals.length > 0 && signals.length < input.message.symbols.length) {
    findings.push(finding('multi_trade_malformed', 'warning', 'Multi-symbol message produced fewer classifier signals than symbols.', `symbols=${input.message.symbols.join(',')}; signals=${signals.length}`, 0.76));
  }

  return findings;
}

async function readDecisionPnl(decision: RunDecision): Promise<number | null> {
  const own = parseMoney(decision.pnl);
  if (own != null) return own;
  if (!decision.tradeId) return null;
  const [trade] = await db.select({
    pnl: schema.trades.pnl,
    realizedPnl: schema.trades.realizedPnl,
  })
    .from(schema.trades)
    .where(eq(schema.trades.id, decision.tradeId))
    .limit(1);
  if (!trade) return null;
  const tradePnl = parseMoney(trade.pnl);
  if (tradePnl != null) return tradePnl;
  return parseMoney(trade.realizedPnl);
}

async function pageCriticalOnce(
  auditId: string,
  alertKey: string | null,
  sendAlert: AuditInput['sendAlert'],
): Promise<void> {
  if (!sendAlert || !alertKey) return;
  const previous = await db.select({ id: schema.classificationAudits.id })
    .from(schema.classificationAudits)
    .where(and(
      eq(schema.classificationAudits.alertKey, alertKey),
      isNotNull(schema.classificationAudits.alertSentAt),
    ))
    .orderBy(desc(schema.classificationAudits.createdAt))
    .limit(1);
  if (previous.length > 0) return;

  const [audit] = await db.select()
    .from(schema.classificationAudits)
    .where(eq(schema.classificationAudits.id, auditId))
    .limit(1);
  if (!audit) return;

  await sendAlert({
    title: `Classification audit: ${audit.category ? audit.category : 'critical'}`,
    message: `${audit.title}\n${audit.details}\nMessage ${audit.messageId} [${audit.channelId}]`,
    severity: 'critical',
  });
  await db.update(schema.classificationAudits)
    .set({ alertSentAt: new Date().toISOString() })
    .where(eq(schema.classificationAudits.id, auditId));
}

function finding(
  category: SafetyFindingCategory,
  severity: SafetySeverity,
  message: string,
  evidence: string,
  confidence: number,
): SafetyFinding {
  return SafetyFindingSchema.parse({ category, severity, message, evidence, confidence });
}

function parseMoney(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clip(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

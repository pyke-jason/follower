import type { Message, Trade } from '@/db/schema.js';
import type { OrchestratorResult } from '@/intents/orchestrator/types.js';
import { getOptionLegs } from '@/lib/trade.js';
import {
  ClassificationGateInputSchema,
  ClassificationGateResultSchema,
  SafetyFindingSchema,
  SafetyGateModeSchema,
  type ClassificationGateResult,
  type ClassificationGateInput,
  type SafetyFinding,
  type SafetyGateMode,
} from './schemas.js';

const LOTTO_YOLO_RE = /\b(?:lotto|yolo)s?\b/i;
const CALLS_WORD_RE = /\bcalls?\b/i;
const PUTS_WORD_RE = /\bputs?\b/i;
const STRIKE_CALL_NOTATION_RE = /\$?\d{1,4}(?:\.\d+)?\s*c\b(?!all)/i;
const STRIKE_PUT_NOTATION_RE = /\$?\d{1,4}(?:\.\d+)?\s*p\b(?!ut)/i;
const SPREAD_RE = /\b(?:cds|pds|pcs|ccs|spread|credit\s+spread|debit\s+spread)\b/i;
const SHARES_RE = /\b(?:shares?|stock|equity|equities)\b/i;
const SOLD_TO_OPEN_RE = /\b(?:sold\s+to\s+open|sto|wrote|writing)\b|\bsold\b[\s\S]{1,40}?\b(?:puts?|calls?|\d{1,4}\s*[cp])\b/i;
const PCT_PNL_RE = /\b(\d{1,3})\s*%\s*(?:profit|gain|loss|return)/i;
const SIZE_QUALIFIER_RE = /\b(?:half|partial(?:s|\s|$)|still\s+holding|some\s+off|scaling|scaled|trimmed?|took\s+partial|\d\/[234]|small\s+part|part\s+of|\d{1,3}\s*%\s*(?:off|out|trim))/i;

export function readSafetyGateMode(): SafetyGateMode {
  return SafetyGateModeSchema.catch('shadow').parse(process.env.SAFETY_GATE_MODE);
}

export function evaluateClassificationGate(params: {
  message: Message;
  resolved: Extract<OrchestratorResult, { outcome: 'EXECUTE' }>;
  openPositions: Trade[];
  mode?: SafetyGateMode;
}): ClassificationGateResult {
  const mode = params.mode === undefined ? readSafetyGateMode() : params.mode;
  const input = ClassificationGateInputSchema.parse({
    messageText: params.message.cleanText,
    badges: params.message.badges,
    symbols: params.message.symbols,
    classifierSignals: params.resolved.classifierSignals,
    resolvedSignals: params.resolved.signals,
  });

  const findings = [
    ...findStockOptionsMismatch(input),
    ...findSoldToOpenDirectionMismatch(input),
    ...findPnlPercentAsTrimSize(input),
    ...findHallucinatedStrikes(input),
    ...findMissingStatedPrice(input),
    ...findAmbiguousExitTarget(input, params.openPositions),
    ...findUnsupportedShortOptionRisk(input),
  ].map((finding) => SafetyFindingSchema.parse(finding));

  const hasCritical = findings.some((finding) => finding.severity === 'critical');
  const decision = mode === 'block' && hasCritical ? 'block' : 'allow';
  const severity = hasCritical
    ? 'critical'
    : findings.some((finding) => finding.severity === 'warning')
      ? 'warning'
      : 'info';
  const reason = findings.length === 0
    ? 'No deterministic safety findings'
    : `${findings.length} safety finding(s): ${findings.map((finding) => finding.category).join(', ')}`;

  return ClassificationGateResultSchema.parse({
    mode,
    decision,
    severity,
    reason,
    findings,
  });
}

function findStockOptionsMismatch(input: ClassificationGateInput): SafetyFinding[] {
  const hasOptionsLanguage = hasOptionLanguage(input.messageText);
  const hasShares = SHARES_RE.test(input.messageText);
  if (!hasOptionsLanguage || hasShares) return [];

  const findings: SafetyFinding[] = [];
  for (let i = 0; i < input.resolvedSignals.length; i++) {
    const signal = input.resolvedSignals[i];
    const resolvedAsStock = signal.legs.every((leg) => leg.type === 'stock');
    if (resolvedAsStock) {
      findings.push({
        category: 'stock_options_mismatch',
        severity: 'critical',
        message: 'Message contains options language but execution resolved a stock trade.',
        evidence: textEvidence(input.messageText),
        signalIndex: i,
        field: 'strategy',
        confidence: 0.94,
      });
    }
  }
  return findings;
}

function findSoldToOpenDirectionMismatch(input: ClassificationGateInput): SafetyFinding[] {
  if (!SOLD_TO_OPEN_RE.test(input.messageText)) return [];
  const findings: SafetyFinding[] = [];
  for (let i = 0; i < input.resolvedSignals.length; i++) {
    const signal = input.resolvedSignals[i];
    if (signal.action !== 'OPEN' && signal.action !== 'ADD') continue;
    const optionLegs = getOptionLegs(signal.legs);
    if (optionLegs.length !== 1) continue;
    const hasSellLeg = optionLegs.some((leg) => leg.side === 'SELL');
    if (!hasSellLeg) {
      findings.push({
        category: 'sell_to_open_direction_mismatch',
        severity: 'critical',
        message: 'Sell-to-open language did not resolve to a short option sale.',
        evidence: textEvidence(input.messageText),
        signalIndex: i,
        field: 'legs',
        confidence: 0.9,
      });
    }
  }
  return findings;
}

function findPnlPercentAsTrimSize(input: ClassificationGateInput): SafetyFinding[] {
  const pnlMatch = PCT_PNL_RE.exec(input.messageText);
  if (!pnlMatch || SIZE_QUALIFIER_RE.test(input.messageText)) return [];
  const pnlFraction = Number.parseInt(pnlMatch[1], 10) / 100;
  const findings: SafetyFinding[] = [];

  for (let i = 0; i < input.resolvedSignals.length; i++) {
    const signal = input.resolvedSignals[i];
    if (signal.action !== 'TRIM') continue;
    if (signal.exitPercent == null || Math.abs(signal.exitPercent - pnlFraction) > 0.01) continue;
    findings.push({
      category: 'pnl_percent_as_trim_size',
      severity: 'critical',
      message: 'The only percentage appears to describe P&L, but it was used as trim size.',
      evidence: pnlMatch[0],
      signalIndex: i,
      field: 'exitPercent',
      confidence: 0.93,
    });
  }
  return findings;
}

function findHallucinatedStrikes(input: ClassificationGateInput): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  input.resolvedSignals.forEach((signal, signalIndex) => {
    if (signal.action !== 'OPEN' && signal.action !== 'ADD') return;
    const optionLegs = getOptionLegs(signal.legs);
    for (const leg of optionLegs) {
      if (!numberAppearsInText(input.messageText, leg.strike)) {
        findings.push({
          category: 'hallucinated_strike',
          severity: 'critical',
          message: 'Execution payload contains an entry strike that does not appear in the message text.',
          evidence: `strike=${leg.strike}; text="${textEvidence(input.messageText)}"`,
          signalIndex,
          field: 'legs',
          confidence: 0.91,
        });
        return;
      }
    }
  });
  return findings;
}

function findMissingStatedPrice(input: ClassificationGateInput): SafetyFinding[] {
  if (!hasClearPriceMarker(input.messageText)) return [];
  const findings: SafetyFinding[] = [];
  for (let i = 0; i < input.resolvedSignals.length; i++) {
    const signal = input.resolvedSignals[i];
    if (signal.limitPrice != null) continue;
    findings.push({
      category: 'missing_stated_price',
      severity: 'critical',
      message: 'Message has a clear fill-price marker, but no stated price reached execution.',
      evidence: textEvidence(input.messageText),
      signalIndex: i,
      field: 'limitPrice',
      confidence: 0.86,
    });
  }
  return findings;
}

function findAmbiguousExitTarget(
  input: ClassificationGateInput,
  openPositions: Trade[],
): SafetyFinding[] {
  if (openPositions.length <= 1 || hasExplicitInstrument(input.messageText)) return [];
  const findings: SafetyFinding[] = [];
  for (let i = 0; i < input.resolvedSignals.length; i++) {
    const signal = input.resolvedSignals[i];
    if (signal.action !== 'CLOSE' && signal.action !== 'TRIM' && signal.action !== 'LEG_OFF') continue;
    findings.push({
      category: 'ambiguous_exit_target',
      severity: 'critical',
      message: 'Exit language is ambiguous while multiple same-trader positions are open.',
      evidence: `${openPositions.length} open positions; text="${textEvidence(input.messageText)}"`,
      signalIndex: i,
      field: 'tradeId',
      confidence: 0.84,
    });
  }
  return findings;
}

function findUnsupportedShortOptionRisk(input: ClassificationGateInput): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (let i = 0; i < input.resolvedSignals.length; i++) {
    const signal = input.resolvedSignals[i];
    if (signal.action !== 'OPEN' && signal.action !== 'ADD') continue;
    const optionLegs = getOptionLegs(signal.legs);
    if (optionLegs.length !== 1 || optionLegs[0].side !== 'SELL') continue;
    findings.push({
      category: 'unsupported_short_option_risk',
      severity: 'critical',
      message: 'Single-leg short option opens are high-risk and require manual handling.',
      evidence: `${optionLegs[0].symbol} ${optionLegs[0].strike}${optionLegs[0].optionType}`,
      signalIndex: i,
      field: 'legs',
      confidence: 0.96,
    });
  }
  return findings;
}

function hasOptionLanguage(text: string): boolean {
  return CALLS_WORD_RE.test(text) ||
    PUTS_WORD_RE.test(text) ||
    STRIKE_CALL_NOTATION_RE.test(text) ||
    STRIKE_PUT_NOTATION_RE.test(text) ||
    SPREAD_RE.test(text) ||
    LOTTO_YOLO_RE.test(text);
}

function hasExplicitInstrument(text: string): boolean {
  return hasOptionLanguage(text) || SHARES_RE.test(text) || /\b\d{1,4}(?:\.\d+)?\b/.test(text);
}

function hasClearPriceMarker(text: string): boolean {
  const textWithoutPnl = text
    .replace(/\bfor\s+[~\s]*\d+(?:\.\d+)?\s*%[^\s]*/gi, '')
    .replace(/\b\d{1,3}\s*%\s*(?:profit|gain|loss|return)s?\b/gi, '')
    .replace(/\b(?:for|of)\s+(?:a\s+)?\$?\d+(?:\.\d+)?\s*c?\s*(?:gain|loss|profit|scratch)\b/gi, '');
  return /\bfor\s+\$?\.?\d/i.test(textWithoutPnl) ||
    /@\s*\$?\d+(?:\.\d+)?/i.test(textWithoutPnl) ||
    /\bat\s+\$\d/i.test(textWithoutPnl);
}

function numberAppearsInText(text: string, value: number): boolean {
  const exact = String(value);
  const noDecimal = exact.replace(/\.0+$/, '');
  return new RegExp(`(?:^|\\D)(?:${escapeRegExp(exact)}|${escapeRegExp(noDecimal)})(?:\\D|$)`).test(text);
}

function textEvidence(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

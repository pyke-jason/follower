import type { DetectedStrategy } from '../db/schema.js';
import { htmlToCleanText } from './html.js';
import { extractBadges } from './badges.js';
import { extractSymbols } from './symbols.js';
import { detectStrategies } from './strategy.js';

export type MessageClassification = {
  cleanText: string;
  badges: string[];
  symbols: string[];
  actionHint: 'OPEN' | 'CLOSE' | null;
  directionHint: 'LONG' | 'SHORT' | null;
  detectedStrategies: DetectedStrategy[];
  isPaperTrade: boolean;
  hasMultipleTrades: boolean;
  confidence: number;
  needsAgent: boolean;
  skipReason?: string;
};

export function classifyMessage(html: string): MessageClassification {
  const cleanText = htmlToCleanText(html);
  const { badges, actionHint, directionHint } = extractBadges(html);
  const symbols = extractSymbols(html);
  const isPaperTrade = /\(paper\)/i.test(cleanText);
  const detectedStrategies = detectStrategies(cleanText, symbols);

  // Confidence scoring
  let confidence = 0;

  if (badges.length === 0) {
    // No badge = no trade signal
    return {
      cleanText, badges, symbols, actionHint, directionHint,
      detectedStrategies, isPaperTrade, hasMultipleTrades: false,
      confidence: 0, needsAgent: false, skipReason: 'no_badge',
    };
  }

  if (isPaperTrade) {
    return {
      cleanText, badges, symbols, actionHint, directionHint,
      detectedStrategies, isPaperTrade, hasMultipleTrades: false,
      confidence: 0, needsAgent: false, skipReason: 'paper_trade',
    };
  }

  // Has badge — start scoring
  confidence = 0.3; // baseline for having a badge

  if (symbols.length > 0) confidence += 0.2;
  if (detectedStrategies.length > 0) {
    confidence += detectedStrategies[0].confidence * 0.4;
  }
  if (actionHint) confidence += 0.1;

  // Cap at 1.0
  confidence = Math.min(confidence, 1.0);
  confidence = Math.round(confidence * 100) / 100;

  const needsAgent = confidence < 0.7;
  const hasMultipleTrades = false; // Cut from v0

  return {
    cleanText, badges, symbols, actionHint, directionHint,
    detectedStrategies, isPaperTrade, hasMultipleTrades,
    confidence, needsAgent,
  };
}

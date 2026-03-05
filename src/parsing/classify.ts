import type { DetectedStrategy } from '../db/schema.js';
import type { ActionHint, Direction } from '../lib/enums.js';
import { htmlToCleanText } from './html.js';
import { extractBadges } from './badges.js';
import { extractSymbols } from './symbols.js';

export type MessageClassification = {
  cleanText: string;
  badges: string[];
  symbols: string[];
  actionHint: ActionHint | null;
  directionHint: Direction | null;
  detectedStrategies: DetectedStrategy[];
  isPaperTrade: boolean;
  confidence: number;
  needsAgent: boolean;
  skipReason?: string;
};

export function classifyMessage(html: string): MessageClassification {
  const cleanText = htmlToCleanText(html);
  const { badges, actionHint, directionHint } = extractBadges(html);
  const symbols = extractSymbols(html);
  const isPaperTrade = /\(paper\)/i.test(cleanText);

  if (badges.length === 0) {
    return {
      cleanText, badges, symbols, actionHint, directionHint,
      detectedStrategies: [], isPaperTrade, confidence: 0, needsAgent: false, skipReason: 'no_badge',
    };
  }

  if (isPaperTrade) {
    return {
      cleanText, badges, symbols, actionHint, directionHint,
      detectedStrategies: [], isPaperTrade, confidence: 0, needsAgent: false, skipReason: 'paper_trade',
    };
  }

  // Agent handles all parsing — no confidence scoring needed
  return {
    cleanText, badges, symbols, actionHint, directionHint,
    detectedStrategies: [], isPaperTrade, confidence: 1, needsAgent: true,
  };
}

import type { Signal } from '@src/agent/schemas';

export type EvalLabel = {
  reasoning: string;
  isTrade: boolean;
  confidence: 'HIGH' | 'LOW';
  trades: Signal[][];
};

export type LabelRow = {
  id: string;
  messageId: string;
  label: EvalLabel;
  source: string;
  model: string | null;
  version: number;
  humanVerified: boolean;
  humanLabel: EvalLabel | null;
  rejectionReason: string | null;
  feedback: string | null;
  reviewedAt: string | null;
  createdAt: string;
  author: string;
  timestamp: string;
  cleanText: string;
  badges: string[];
  symbols: string[];
};

export const REJECTION_REASONS = [
  { value: 'NOT_TRADE', label: 'Not a trade' },
  { value: 'MISSED_TRADE', label: 'Missed trade' },
  { value: 'WRONG_SIGNALS', label: 'Wrong signals' },
  { value: 'WRONG_ACTION', label: 'Wrong action' },
  { value: 'WRONG_DIRECTION', label: 'Wrong direction' },
  { value: 'OTHER', label: 'Other' },
] as const;

export type LabelsResponse = {
  rows: LabelRow[];
  total: number;
  stats: {
    total: number;
    verified: number;
    lowConfidence: number;
    bySource: { agent: number; human: number };
  };
};

export type ChatContext = {
  target: string;
  author: string;
  messages: Array<{
    id: string;
    author: string;
    cleanText: string;
    badges: string[];
    symbols: string[];
    timestamp: string;
  }>;
};

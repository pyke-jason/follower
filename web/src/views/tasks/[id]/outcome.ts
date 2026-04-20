import { CircleCheck, CircleAlert, CircleX, SkipForward, Loader2 } from 'lucide-react';
import type { Task, RunDecision } from '@src/db/schema';

export type OutcomeKind =
  | 'EXECUTE_TRADE'
  | 'MANUAL_REVIEW'
  | 'SKIP'
  | 'FAILED'
  | 'PENDING'
  | 'IN_PROGRESS';

export function deriveOutcome(task: Task): OutcomeKind {
  if (task.status === 'FAILED' || task.error) return 'FAILED';
  if (task.status === 'PENDING') return 'PENDING';
  if (task.status === 'IN_PROGRESS') return 'IN_PROGRESS';
  const resultOutcome = task.result?.outcome;
  if (resultOutcome === 'EXECUTE') return 'EXECUTE_TRADE';
  if (resultOutcome === 'MANUAL_REVIEW') return 'MANUAL_REVIEW';
  if (resultOutcome === 'SKIP' || task.status === 'SKIPPED') return 'SKIP';
  return 'MANUAL_REVIEW';
}

export const OUTCOME_META: Record<OutcomeKind, { label: string; icon: typeof CircleCheck; tone: string }> = {
  EXECUTE_TRADE: { label: 'EXECUTE TRADE', icon: CircleCheck,  tone: 'text-profit' },
  MANUAL_REVIEW: { label: 'MANUAL REVIEW', icon: CircleAlert,  tone: 'text-warning' },
  SKIP:          { label: 'SKIP',          icon: SkipForward,  tone: 'text-muted-foreground' },
  FAILED:        { label: 'FAILED',        icon: CircleX,      tone: 'text-loss' },
  PENDING:       { label: 'PENDING',       icon: Loader2,      tone: 'text-warning' },
  IN_PROGRESS:   { label: 'IN PROGRESS',   icon: Loader2,      tone: 'text-info' },
};

export function summarizeTask(
  task: Task,
  runDecision: RunDecision | null,
  outcome: OutcomeKind,
): string | null {
  if (outcome === 'FAILED' && task.error) {
    const firstLine = task.error.split('\n')[0];
    return firstLine.length > 180 ? firstLine.slice(0, 180) + '...' : firstLine;
  }
  if (runDecision?.reasoning) return runDecision.reasoning;
  if (outcome === 'MANUAL_REVIEW') return 'Classifier flagged this signal for human review.';
  if (outcome === 'SKIP') return 'Signal was skipped — no trade was opened.';
  if (outcome === 'PENDING') return 'Awaiting classifier.';
  if (outcome === 'IN_PROGRESS') return 'Classifier is running.';
  return null;
}

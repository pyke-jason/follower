import { CircleX } from 'lucide-react';
import { InfoChip } from '@/components/info-chip';
import { Card } from '@/components/ui/card';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Task, RunDecision } from '@src/db/schema';
import type { OutcomeKind } from './outcome';

type TimelineStep = {
  id: string;
  label: string;
  tone: 'default' | 'active' | 'success' | 'warn' | 'error' | 'muted';
  detail?: string;
  chips?: { label: string }[];
  timestamp?: string | null;
};

const TONE_DOT: Record<TimelineStep['tone'], string> = {
  default: 'bg-muted-foreground/50',
  active:  'bg-info animate-pulse',
  success: 'bg-profit',
  warn:    'bg-warning',
  error:   'bg-loss',
  muted:   'bg-muted-foreground/30',
};

const TONE_LABEL: Record<TimelineStep['tone'], string> = {
  default: 'text-foreground',
  active:  'text-info',
  success: 'text-foreground',
  warn:    'text-warning',
  error:   'text-loss',
  muted:   'text-muted-foreground',
};

export function DecisionTimeline({ task, runDecision, outcome }: {
  task: Task;
  runDecision: RunDecision | null;
  outcome: OutcomeKind;
}) {
  const steps = buildSteps(task, runDecision, outcome);
  if (steps.length === 0 && !task.error) return null;

  return (
    <section>
      <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-3">
        Decision
      </h4>
      <Card className="py-0 gap-0 overflow-hidden">
        <div className="p-4">
          {steps.map((step, i) => (
            <TimelineRow
              key={step.id}
              step={step}
              isLast={i === steps.length - 1 && !task.error}
            />
          ))}
          {task.error && (
            <ErrorRow
              error={task.error}
              outcome={outcome}
              runDecision={runDecision}
            />
          )}
        </div>
      </Card>
    </section>
  );
}

function TimelineRow({ step, isLast }: { step: TimelineStep; isLast: boolean }) {
  return (
    <div className={cn('relative pl-6', !isLast && 'pb-4')}>
      {!isLast && <div className="absolute left-[5px] top-3 bottom-0 w-px bg-border/50" />}
      <div
        className={cn(
          'absolute left-0 top-1.5 w-[11px] h-[11px] rounded-full ring-2 ring-background',
          TONE_DOT[step.tone],
        )}
      />
      <div className="flex flex-wrap items-baseline gap-2">
        <span className={cn('text-sm font-medium', TONE_LABEL[step.tone])}>
          {step.label}
        </span>
        {step.chips?.map((c, i) => <InfoChip key={i} label={c.label} />)}
        {step.timestamp && (
          <span className="text-[11px] text-muted-foreground/70 tabular-nums ml-auto">
            {formatDate(step.timestamp)}
          </span>
        )}
      </div>
      {step.detail && (
        <p className="text-sm text-muted-foreground leading-relaxed mt-1">
          {step.detail}
        </p>
      )}
    </div>
  );
}

function ErrorRow({ error, outcome, runDecision }: {
  error: string;
  outcome: OutcomeKind;
  runDecision: RunDecision | null;
}) {
  const phase = inferFailurePhase(error, runDecision);
  return (
    <div className="relative pl-6">
      <div className="absolute left-0 top-1.5 w-[11px] h-[11px] rounded-full ring-2 ring-background bg-loss" />
      <Alert variant="destructive">
        <CircleX />
        <AlertTitle>{phase}</AlertTitle>
        <AlertDescription>
          <pre className="text-xs whitespace-pre-wrap font-mono w-full">{error}</pre>
          {outcome === 'FAILED' && (
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
              Task status: FAILED
            </span>
          )}
        </AlertDescription>
      </Alert>
    </div>
  );
}

function inferFailurePhase(error: string, runDecision: RunDecision | null): string {
  const lower = error.toLowerCase();
  if (lower.includes('sidecar') || lower.includes('ibkr')) return 'Broker call failed';
  if (lower.includes('quote')) return 'Quote lookup failed';
  if (lower.includes('order')) return 'Order placement failed';
  if (lower.includes('risk')) return 'Risk check failed';
  if (lower.includes('parse')) return 'Parse failed';
  if (runDecision?.phase === 'orchestrator') return 'Agent call failed';
  return 'Task failed';
}

function buildSteps(
  task: Task,
  runDecision: RunDecision | null,
  outcome: OutcomeKind,
): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const snap = (runDecision?.snapshot ?? null) as Record<string, unknown> | null;

  if (runDecision || task.messageId) {
    const parts: string[] = [];
    if (snap?.action) parts.push(String(snap.action));
    if (snap?.symbol) parts.push(String(snap.symbol));
    if (snap?.strategy) parts.push(String(snap.strategy));
    const flags = Array.isArray(snap?.complexityFlags) ? (snap.complexityFlags as unknown[]) : [];
    const chips = flags.map((f) => ({ label: String(f) }));

    steps.push({
      id: 'parsed',
      label: 'Parsed',
      tone: 'success',
      detail: parts.length > 0 ? parts.join(' · ') : 'Message parsed',
      chips: chips.length > 0 ? chips : undefined,
      timestamp: runDecision?.createdAt ?? task.createdAt ?? null,
    });
  }

  const route = snap?.route ? String(snap.route) : null;
  if (route) {
    const label = route === 'deterministic'
      ? 'Deterministic path'
      : route === 'orchestrator'
        ? 'Orchestrator path'
        : route === 'llm'
          ? 'LLM path'
          : `Route: ${route}`;
    const detail = route === 'deterministic'
      ? 'Routed without LLM — parser confidence was high.'
      : route === 'llm' || route === 'orchestrator'
        ? 'Routed to agent for full classification.'
        : null;
    steps.push({
      id: 'routed',
      label,
      tone: 'default',
      detail: detail ?? undefined,
    });
  }

  if (outcome === 'PENDING') {
    steps.push({ id: 'outcome', label: 'Pending', tone: 'muted', detail: 'Task queued for the agent.' });
  } else if (outcome === 'IN_PROGRESS') {
    steps.push({ id: 'outcome', label: 'Running', tone: 'active', detail: 'Agent is processing the message.' });
  } else if (outcome === 'EXECUTE_TRADE') {
    steps.push({
      id: 'outcome',
      label: 'Execute trade',
      tone: 'success',
      detail: runDecision?.reasoning ?? 'Agent approved execution.',
      timestamp: task.completedAt ?? null,
    });
  } else if (outcome === 'MANUAL_REVIEW') {
    steps.push({
      id: 'outcome',
      label: 'Manual review',
      tone: 'warn',
      detail: runDecision?.reasoning ?? 'Agent deferred to a human.',
      timestamp: task.completedAt ?? null,
    });
  } else if (outcome === 'SKIP') {
    steps.push({
      id: 'outcome',
      label: 'Skipped',
      tone: 'muted',
      detail: runDecision?.reasoning ?? 'Agent skipped this signal.',
      timestamp: task.completedAt ?? null,
    });
  }

  return steps;
}

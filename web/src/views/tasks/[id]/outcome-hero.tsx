import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/badge';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Task, TaskContext } from '@src/db/schema';
import type { useScopedHref } from '@/hooks/use-scoped-href';
import { OUTCOME_META, type OutcomeKind } from './outcome';

export function OutcomeHero({ task, outcome, symbol, context, reason, href }: {
  task: Task;
  outcome: OutcomeKind;
  symbol: string;
  context: TaskContext | null;
  reason: string | null;
  href: ReturnType<typeof useScopedHref>;
}) {
  const meta = OUTCOME_META[outcome];
  const Icon = meta.icon;
  const isSpinning = outcome === 'PENDING' || outcome === 'IN_PROGRESS';
  const duration = task.startedAt && task.completedAt
    ? formatDuration(task.startedAt, task.completedAt)
    : null;
  const direction = context?.directionHint;
  const strategy = context?.detectedStrategies?.[0]?.strategy;

  return (
    <div className="flex items-start gap-4">
      <Link
        to={href('/tasks')}
        className="text-sm text-muted-foreground hover:text-foreground transition-colors pt-1"
      >
        <ArrowLeft className="h-4 w-4" />
      </Link>

      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <Icon className={cn('h-6 w-6 shrink-0', meta.tone, isSpinning && 'animate-spin')} />
          <span className={cn('text-xl font-bold tracking-tight', meta.tone)}>
            {meta.label}
          </span>
          <span className="text-lg font-semibold text-foreground">{symbol}</span>
          {direction && <Badge label={direction} />}
          {strategy && <Badge label={strategy} />}
          {duration && (
            <span className="text-xs text-muted-foreground tabular-nums ml-auto">
              {duration}
            </span>
          )}
        </div>

        {reason && (
          <p className="text-sm text-muted-foreground leading-relaxed mt-2 line-clamp-3">
            {reason}
          </p>
        )}

        {context?.author && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span>from</span>
            <Link
              to={href(`/traders/${encodeURIComponent(context.author)}`)}
              className="hover:text-foreground transition-colors font-medium"
            >
              {context.author}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

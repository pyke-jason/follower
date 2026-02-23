import Link from 'next/link';
import { Badge } from './badge';
import { buildHref } from '@/lib/run-scope';

type Props = {
  sourceMessage?: { cleanText: string; author: string; timestamp: string } | null;
  decision?: {
    decision: string;
    reasoning?: string | null;
    path?: string | null;
    durationMs?: number | null;
    pnl?: string | null;
  } | null;
  taskId?: string | null;
  runId?: string;
};

export function SignalDecisionSummary({ sourceMessage, decision, taskId, runId }: Props) {
  if (!sourceMessage && !decision) {
    return <p className="text-xs text-muted-foreground/60">No signal data</p>;
  }

  return (
    <div className="space-y-2">
      {sourceMessage && (
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-medium">{sourceMessage.author}</span>
            <span className="text-[10px] text-muted-foreground/60">{sourceMessage.timestamp}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-3">{sourceMessage.cleanText}</p>
        </div>
      )}

      {decision && (
        <div className="flex items-start gap-2">
          <Badge label={decision.decision} />
          {decision.reasoning && (
            <p className="text-xs text-muted-foreground line-clamp-2">{decision.reasoning}</p>
          )}
        </div>
      )}

      {taskId && (
        <Link
          href={buildHref(`/tasks/${taskId}`, runId)}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline underline-offset-2 decoration-muted-foreground/40 transition-colors"
        >
          View Decision &rarr;
        </Link>
      )}
    </div>
  );
}

import { Badge } from '../../components/badge';
import { InfoChip } from '../../components/info-chip';
import { Card } from '@/components/ui/card';
import {
  Accordion, AccordionItem, AccordionTrigger, AccordionContent,
} from '@/components/ui/accordion';
import { formatCurrency, pnlColor, formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

type Decision = {
  outcome: string;
  reasoning: string | null;
  phase: string | null;
  durationMs: number | null;
  pnl: string | null;
};

export function DecisionReasoning({
  decision,
  taskStartedAt,
  taskCompletedAt,
}: {
  decision: Decision | null;
  taskStartedAt?: string | null;
  taskCompletedAt?: string | null;
}) {
  if (!decision) return null;

  return (
    <Card className="py-0 gap-0 overflow-hidden">
      <Accordion type="single" collapsible>
        <AccordionItem value="decision">
          <AccordionTrigger className="px-4">Signal Decision</AccordionTrigger>
          <AccordionContent className="px-4">
            <div className="flex items-center gap-3 mb-3">
              <Badge label={decision.outcome} />
              {decision.phase ? <InfoChip label={decision.phase} /> : <InfoChip label="agent" />}
              {decision.pnl != null && (
                <span className={cn('font-medium tabular-nums', pnlColor(decision.pnl))}>
                  {formatCurrency(decision.pnl)}
                </span>
              )}
              {decision.durationMs != null ? (
                <span className="text-xs text-muted-foreground tabular-nums ml-auto">
                  {decision.durationMs < 1000
                    ? `${decision.durationMs}ms`
                    : `${(decision.durationMs / 1000).toFixed(1)}s`}
                </span>
              ) : taskStartedAt && taskCompletedAt ? (
                <span className="text-xs text-muted-foreground tabular-nums ml-auto">
                  {formatDuration(taskStartedAt, taskCompletedAt)}
                </span>
              ) : null}
            </div>
            {decision.reasoning && (
              <p className="text-sm text-muted-foreground leading-relaxed">
                {decision.reasoning}
              </p>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Card>
  );
}

import { Badge } from './badge';
import { InfoChip } from './info-chip';
import { SnapshotDetail } from './snapshot-detail';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  Accordion, AccordionItem, AccordionTrigger, AccordionContent,
} from '@/components/ui/accordion';
import { cn } from '@/lib/utils';
import { formatCurrency, pnlColor } from '@/lib/format';
import { GitBranch } from 'lucide-react';
import type { RunDecision } from '../../../src/db/schema';

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function TokenChip({ input, output }: { input: number; output: number }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground tabular-nums bg-muted/40 border border-border/30 rounded px-1.5 py-0.5">
      {input.toLocaleString()}in / {output.toLocaleString()}out
    </span>
  );
}

export function DecisionTimeline({ decisions }: { decisions: RunDecision[] }) {
  if (decisions.length === 0) return null;

  return (
    <Card className="py-0 gap-0">
      <CardHeader className="border-b py-3 px-4">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
          Decision Timeline
        </CardTitle>
      </CardHeader>
      <CardContent className="py-3">
        <Accordion type="multiple">
          <div className="space-y-1.5">
            {decisions.map((d, i) => (
              <AccordionItem key={d.id} value={d.id} className="border-b-0">
                <div className="border border-border rounded-md">
                  <AccordionTrigger className="px-3 py-2 hover:no-underline [&[data-state=open]]:border-b [&[data-state=open]]:border-border/50">
                    <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
                      <span className="text-xs text-muted-foreground tabular-nums w-5 shrink-0">{i + 1}.</span>
                      <Badge label={d.phase} />
                      <Badge label={d.outcome} />
                      {d.signalIndex != null && (
                        <InfoChip label={`signal ${d.signalIndex}`} />
                      )}
                      {d.reasoning && (
                        <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                          {d.reasoning}
                        </span>
                      )}
                      <div className="flex items-center gap-2 ml-auto shrink-0">
                        {d.pnl != null && parseFloat(d.pnl) !== 0 && (
                          <span className={cn('text-xs font-medium tabular-nums', pnlColor(d.pnl))}>
                            {formatCurrency(d.pnl)}
                          </span>
                        )}
                        {d.inputTokens != null && d.outputTokens != null && (
                          <TokenChip input={d.inputTokens} output={d.outputTokens} />
                        )}
                        {d.durationMs != null && (
                          <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                            {formatMs(d.durationMs)}
                          </span>
                        )}
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="px-3">
                    <div className="space-y-3">
                      {d.reasoning && (
                        <p className="text-sm text-muted-foreground leading-relaxed">
                          {d.reasoning}
                        </p>
                      )}
                      {d.snapshot && Object.keys(d.snapshot).length > 0 && (
                        <SnapshotDetail snapshot={d.snapshot} />
                      )}
                      {!d.reasoning && (!d.snapshot || Object.keys(d.snapshot).length === 0) && (
                        <p className="text-xs text-muted-foreground/60 italic">No additional detail</p>
                      )}
                    </div>
                  </AccordionContent>
                </div>
              </AccordionItem>
            ))}
          </div>
        </Accordion>
      </CardContent>
    </Card>
  );
}

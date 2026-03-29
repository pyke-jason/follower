import { Badge } from '@/components/badge';
import { InfoChip } from '@/components/info-chip';
import { StatItem } from '@/components/stat-item';
import { Card } from '@/components/ui/card';
import {
  Accordion, AccordionItem, AccordionTrigger, AccordionContent,
} from '@/components/ui/accordion';
import type { TaskContext } from '@src/db/schema';

export function ParsedContext({ context }: { context: TaskContext }) {
  const hasContent =
    context.confidence != null ||
    context.actionHint ||
    context.directionHint ||
    (context.detectedStrategies?.length ?? 0) > 0 ||
    (context.badges?.length ?? 0) > 0;

  if (!hasContent) return null;

  return (
    <Card className="py-0 gap-0 overflow-hidden">
      <Accordion type="single" collapsible>
        <AccordionItem value="context">
          <AccordionTrigger className="px-4">Parsed Context</AccordionTrigger>
          <AccordionContent className="px-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              {context.confidence != null && (
                <StatItem label="Confidence">
                  <p className={`font-medium tabular-nums ${
                    context.confidence >= 0.8
                      ? 'text-profit'
                      : context.confidence >= 0.5
                        ? 'text-warning'
                        : 'text-loss'
                  }`}>
                    {(context.confidence * 100).toFixed(0)}%
                  </p>
                </StatItem>
              )}
              {context.actionHint && (
                <StatItem label="Action">
                  <Badge label={context.actionHint} />
                </StatItem>
              )}
              {context.directionHint && (
                <StatItem label="Direction">
                  <Badge label={context.directionHint} />
                </StatItem>
              )}
              {context.symbols && context.symbols.length > 0 && (
                <StatItem label="Symbols">
                  <div className="flex gap-1 flex-wrap">
                    {context.symbols.map((s, i) => (
                      <InfoChip key={i} label={s} />
                    ))}
                  </div>
                </StatItem>
              )}
            </div>
            {context.detectedStrategies && context.detectedStrategies.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border/50">
                <StatItem label="Strategies">
                  <div className="flex items-center gap-2 flex-wrap">
                    {context.detectedStrategies.map((ds, i) => (
                      <div key={i} className="flex items-center gap-1">
                        <Badge label={ds.strategy} />
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {(ds.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </StatItem>
              </div>
            )}
            {context.badges && context.badges.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border/50">
                <StatItem label="Badges">
                  <div className="flex gap-1 flex-wrap">
                    {context.badges.map((b, i) => <Badge key={i} label={b} />)}
                  </div>
                </StatItem>
              </div>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Card>
  );
}

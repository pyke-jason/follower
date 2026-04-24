import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { Badge } from '@/components/badge';
import { cn } from '@/lib/utils';
import { Brain } from 'lucide-react';
import type { MessageIntent } from '@src/db/schema';

/**
 * LLM reasoning detail for a source message. Shows the agent's final reasoning
 * and, when available, each intermediate tool-call step (tool name, input, output,
 * and thought). Only rendered when the intent route was 'llm'; deterministic
 * paths have nothing meaningful here. Renders without its own card — callers
 * embed it into the outer timeline card so the agent's thinking visually
 * leads into the execution events.
 */
export function LlmReasoning({ intent }: { intent: MessageIntent | null }) {
  if (!intent || intent.route !== 'llm') return null;

  const steps = intent.steps ?? [];
  const totalMs = intent.durationMs;
  const totalTokens = (intent.inputTokens ?? 0) + (intent.outputTokens ?? 0);

  return (
    <Accordion type="single" collapsible defaultValue="llm">
      <AccordionItem value="llm" className="border-b-0">
          <AccordionTrigger className="px-3 py-3 hover:no-underline">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
              <Brain className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="min-w-0 text-sm font-medium">Agent reasoning</span>
              <Badge label={intent.model} className="max-w-full truncate" />
              <Badge label={intent.decision} />
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground/70 tabular-nums">
                {totalMs != null && <span>{formatMs(totalMs)}</span>}
                {totalTokens > 0 && <span>{totalTokens.toLocaleString()} tok</span>}
                {steps.length > 0 && <span>{steps.length} step{steps.length === 1 ? '' : 's'}</span>}
              </span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="min-w-0 px-3 space-y-3">
            {intent.reasoning && (
              <div>
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
                  Final rationale
                </p>
                <p className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">
                  {intent.reasoning}
                </p>
              </div>
            )}

            {steps.length > 0 && (
              <div>
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
                  Tool steps
                </p>
                <ol className="space-y-2">
                  {steps.map((step, i) => (
                    <li
                      key={i}
                      className={cn(
                        'pl-3 border-l-2 border-border',
                        step.toolName && 'border-info/40',
                      )}
                    >
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-[10px] tabular-nums text-muted-foreground/60">
                          #{i + 1}
                        </span>
                        {step.toolName && (
                          <span className="text-xs font-mono font-medium text-info">
                            {step.toolName}
                          </span>
                        )}
                        {step.durationMs != null && (
                          <span className="text-[10px] text-muted-foreground/50 tabular-nums ml-auto">
                            {formatMs(step.durationMs)}
                          </span>
                        )}
                      </div>
                      {step.reasoning && (
                        <p className="text-xs text-foreground/70 leading-relaxed mt-1 whitespace-pre-wrap">
                          {step.reasoning}
                        </p>
                      )}
                      {step.toolInput != null && (
                        <pre className="text-[10px] font-mono bg-muted/40 rounded px-2 py-1 mt-1 overflow-x-auto whitespace-pre-wrap">
                          {safeStringify(step.toolInput)}
                        </pre>
                      )}
                      {step.toolOutput != null && (
                        <pre className="text-[10px] font-mono bg-muted/20 rounded px-2 py-1 mt-1 overflow-x-auto whitespace-pre-wrap text-muted-foreground">
                          → {safeStringify(step.toolOutput)}
                        </pre>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function safeStringify(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    return s.length > 600 ? s.slice(0, 600) + '…' : s;
  } catch {
    return String(v);
  }
}

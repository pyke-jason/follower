'use client';

import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { TaskStep } from '../../../src/db/schema';

export function StepViewer({ steps }: { steps: TaskStep[] }) {
  if (steps.length === 0) {
    return <p className="text-muted-foreground text-sm">No steps recorded.</p>;
  }

  return (
    <Accordion type="multiple" className="border rounded-lg overflow-hidden">
      {steps.map((step) => (
        <AccordionItem key={step.id} value={step.id} className="border-b last:border-b-0 px-1">
          <AccordionTrigger className="py-2 px-3 hover:no-underline">
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground font-mono w-6">
                #{step.stepNumber}
              </span>
              {step.toolName ? (
                <span className="text-sm font-medium text-blue-400">
                  {step.toolName}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground italic">Reasoning</span>
              )}
              {step.durationMs != null && (
                <span className="text-xs text-muted-foreground/60">{step.durationMs}ms</span>
              )}
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-3 space-y-3">
            {step.reasoning && (
              <div>
                <p className="text-xs text-muted-foreground uppercase mb-1">Reasoning</p>
                <pre className="text-sm text-foreground/80 whitespace-pre-wrap font-mono">
                  {step.reasoning}
                </pre>
              </div>
            )}
            {step.toolInput != null && (
              <div>
                <p className="text-xs text-muted-foreground uppercase mb-1">Input</p>
                <pre className="text-xs text-muted-foreground bg-background rounded p-2 overflow-x-auto font-mono">
                  {JSON.stringify(step.toolInput, null, 2)}
                </pre>
              </div>
            )}
            {step.toolOutput != null && (
              <div>
                <p className="text-xs text-muted-foreground uppercase mb-1">Output</p>
                <pre className="text-xs text-muted-foreground bg-background rounded p-2 overflow-x-auto font-mono max-h-64 overflow-y-auto">
                  {JSON.stringify(step.toolOutput, null, 2)}
                </pre>
              </div>
            )}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

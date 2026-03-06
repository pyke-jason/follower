import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export function CollapsibleError({ error }: { error: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="rounded-lg border border-loss/30 bg-loss/5 px-4 py-2.5 flex items-start gap-3 text-xs font-mono text-loss/80 cursor-pointer"
      onClick={() => setExpanded(!expanded)}
    >
      <pre className={`whitespace-pre-wrap flex-1 ${!expanded ? 'line-clamp-2' : ''}`}>
        {error}
      </pre>
      <div className="shrink-0 pt-0.5 text-loss/40">
        {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
      </div>
    </div>
  );
}

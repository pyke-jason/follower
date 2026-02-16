'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import { CopyButton } from '../../components/copy-button';

export function LogViewer({
  runId,
  isRunning,
  defaultCollapsed = true,
}: {
  runId: string;
  isRunning: boolean;
  defaultCollapsed?: boolean;
}) {
  const [logs, setLogs] = useState('');
  const [open, setOpen] = useState(!defaultCollapsed);
  const [height, setHeight] = useState(560);
  const preRef = useRef<HTMLPreElement>(null);
  const wasAtBottom = useRef(true);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const getLogs = useCallback(() => logs, [logs]);

  useEffect(() => {
    let cancelled = false;

    async function fetchLogs() {
      try {
        const res = await fetch(`/api/backtests/${runId}/logs`);
        if (!cancelled && res.ok) {
          const text = await res.text();
          setLogs(text);
        }
      } catch {
        // ignore fetch errors
      }
    }

    fetchLogs();

    if (isRunning) {
      const interval = setInterval(fetchLogs, 2000);
      return () => { cancelled = true; clearInterval(interval); };
    }

    return () => { cancelled = true; };
  }, [runId, isRunning]);

  useEffect(() => {
    const el = preRef.current;
    if (el && wasAtBottom.current && open && isRunning) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs, open, isRunning]);

  function handleScroll() {
    const el = preRef.current;
    if (el) {
      wasAtBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    }
  }

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [height]);

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const delta = dragRef.current.startY - e.clientY;
    setHeight(Math.max(dragRef.current.startH + delta, 120));
  }, []);

  const onResizeEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  const lineCount = logs ? logs.split('\n').length : 0;

  return (
    <div className="sticky bottom-0 -mx-6 z-40 flex flex-col border-t border-border bg-card">
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); }
        }}
        className="flex items-center gap-2 px-4 py-1.5 text-xs hover:bg-muted/40 transition-colors cursor-pointer select-none"
      >
        <Terminal className="size-3 text-muted-foreground" />
        <span className="font-medium text-muted-foreground">Logs</span>
        {lineCount > 0 && (
          <span className="text-muted-foreground/60 tabular-nums">{lineCount.toLocaleString()} lines</span>
        )}
        {isRunning && (
          <span className="size-1.5 rounded-full bg-profit animate-pulse" />
        )}
        <div className="ml-auto flex items-center gap-1">
          <CopyButton getText={getLogs} />
          {open ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronUp className="size-3 text-muted-foreground" />}
        </div>
      </div>
      {open && (
        <>
          <div
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            className="h-1 cursor-ns-resize hover:bg-border transition-colors border-t border-border/50"
          />
          <pre
            ref={preRef}
            onScroll={handleScroll}
            style={{ height }}
            className="overflow-y-auto px-4 py-2 text-xs font-mono text-muted-foreground whitespace-pre-wrap"
          >
            {logs || 'No logs yet.'}
          </pre>
        </>
      )}
    </div>
  );
}

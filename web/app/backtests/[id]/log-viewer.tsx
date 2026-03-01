'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { CopyButton } from '../../components/copy-button';
import { ScrollToBottom } from '../../components/scroll-to-bottom';

export function LogViewer({
  runId,
  isRunning,
  defaultCollapsed = true,
}: {
  runId: string;
  isRunning: boolean;
  defaultCollapsed?: boolean;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
  const [height, setHeight] = useState(560);
  const [lineCount, setLineCount] = useState(0);
  const [pinned, setPinned] = useState(true);
  const preRef = useRef<HTMLPreElement>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  // Full log text lives in a ref so updates don't trigger React re-renders
  // of the <pre> content (which would nuke the user's text selection).
  const logsRef = useRef('');
  const renderedLenRef = useRef(0);

  const getLogs = useCallback(() => logsRef.current, []);

  const scrollToBottom = useCallback(() => {
    const el = preRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      setPinned(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchLogs() {
      try {
        const res = await fetch(`/api/backtests/${runId}/logs`);
        if (!cancelled && res.ok) {
          const text = await res.text();
          if (text === logsRef.current) return;
          logsRef.current = text;
          setLineCount(text ? text.split('\n').length : 0);

          // Append only the new portion to the DOM so existing text
          // nodes (and any user selection on them) are preserved.
          const el = preRef.current;
          if (el) {
            const delta = text.slice(renderedLenRef.current);
            if (delta) {
              el.appendChild(document.createTextNode(delta));
              renderedLenRef.current = text.length;
            }
            setPinned((p) => {
              if (p) el.scrollTop = el.scrollHeight;
              return p;
            });
          }
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
  }, [runId, isRunning, open]);

  // When the panel opens, render the full log text we already have.
  useEffect(() => {
    const el = preRef.current;
    if (el && open) {
      el.textContent = logsRef.current || 'No logs yet.';
      renderedLenRef.current = logsRef.current.length;
      if (pinned) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [open]);

  function handleScroll() {
    const el = preRef.current;
    if (el) {
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
      setPinned(atBottom);
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

  return (
    <div className="sticky bottom-0 -mx-6 z-40 flex flex-col border-t border-border bg-card">
      <div className="flex items-center gap-2 px-4 py-1.5 text-xs">
        <Terminal className="size-3 text-muted-foreground" />
        <span className="font-medium text-muted-foreground">Logs</span>
        {lineCount > 0 && (
          <span className="text-muted-foreground/60 tabular-nums">{lineCount.toLocaleString()} lines</span>
        )}
        {isRunning && open && (
          <span
            className={`size-1.5 rounded-full transition-colors ${pinned ? 'bg-profit animate-pulse' : 'bg-warning'}`}
            title={pinned ? 'Following output' : 'Scrolled away'}
          />
        )}
        {isRunning && !open && (
          <span className="size-1.5 rounded-full bg-profit animate-pulse" />
        )}
        <CopyButton getText={getLogs} />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setOpen((o) => !o)}
          title={open ? 'Collapse logs' : 'Expand logs'}
          className="ml-auto text-muted-foreground"
        >
          {open ? <ChevronDown /> : <ChevronUp />}
        </Button>
      </div>
      {open && (
        <>
          <div
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            className="h-1 cursor-ns-resize hover:bg-border transition-colors border-t border-border/50"
          />
          <div className="relative" style={{ height }}>
            <pre
              ref={preRef}
              onScroll={handleScroll}
              className="absolute inset-0 overflow-y-auto px-4 py-2 text-xs font-mono text-muted-foreground whitespace-pre-wrap scrollbar-thin"
            />
            {!pinned && <ScrollToBottom onClick={scrollToBottom} />}
          </div>
        </>
      )}
    </div>
  );
}

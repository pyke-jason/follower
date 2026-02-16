'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ChevronRight } from 'lucide-react';
import { CopyButton } from '../../components/copy-button';

export function LogViewer({
  runId,
  isRunning,
  defaultCollapsed = false,
}: {
  runId: string;
  isRunning: boolean;
  defaultCollapsed?: boolean;
}) {
  const [logs, setLogs] = useState('');
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const preRef = useRef<HTMLPreElement>(null);
  const wasAtBottom = useRef(true);

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
    if (el && wasAtBottom.current && !collapsed && isRunning) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs, collapsed, isRunning]);

  function handleScroll() {
    const el = preRef.current;
    if (el) {
      wasAtBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    }
  }

  if (!logs) return null;

  const lineCount = logs.split('\n').length;

  return (
    <Card className="py-0 gap-0">
      <CardHeader
        className="border-b py-3 px-4 cursor-pointer select-none flex items-center gap-2"
        onClick={() => setCollapsed((c) => !c)}
      >
        <ChevronRight
          className={`size-4 text-muted-foreground transition-transform ${collapsed ? '' : 'rotate-90'}`}
        />
        <CardTitle className="text-sm flex-1">
          Process Logs
          {collapsed && (
            <span className="ml-2 text-muted-foreground font-normal">
              &middot; {lineCount.toLocaleString()} lines
            </span>
          )}
        </CardTitle>
        <CopyButton getText={getLogs} className="ml-auto" />
      </CardHeader>
      {!collapsed && (
        <CardContent className="p-0">
          <pre
            ref={preRef}
            onScroll={handleScroll}
            className="max-h-96 overflow-y-auto p-4 text-xs font-mono text-muted-foreground whitespace-pre-wrap"
          >
            {logs}
          </pre>
        </CardContent>
      )}
    </Card>
  );
}

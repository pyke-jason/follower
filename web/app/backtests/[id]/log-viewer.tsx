'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

export function LogViewer({ runId, isRunning }: { runId: string; isRunning: boolean }) {
  const [logs, setLogs] = useState('');
  const preRef = useRef<HTMLPreElement>(null);
  const wasAtBottom = useRef(true);

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
    if (el && wasAtBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  function handleScroll() {
    const el = preRef.current;
    if (el) {
      wasAtBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    }
  }

  if (!logs) return null;

  return (
    <Card className="py-0 gap-0">
      <CardHeader className="border-b py-3 px-4">
        <CardTitle className="text-sm">Process Logs</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <pre
          ref={preRef}
          onScroll={handleScroll}
          className="max-h-96 overflow-y-auto p-4 text-xs font-mono text-muted-foreground whitespace-pre-wrap"
        >
          {logs}
        </pre>
      </CardContent>
    </Card>
  );
}

'use client';

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

interface DiffRow {
  messageId: string;
  decisionA: string | null;
  decisionB: string | null;
  pnlA: number;
  pnlB: number;
  delta: number;
  reasoningA: string | null;
  reasoningB: string | null;
  message: { id: string; cleanText: string; author: string } | null;
}

export function DecisionDiff({
  diffs,
  runAName,
  runBName,
}: {
  diffs: DiffRow[];
  runAName: string;
  runBName: string;
}) {
  const totalDelta = diffs.reduce((sum, d) => sum + d.delta, 0);

  return (
    <div>
      <div className="px-4 py-2 border-b border-border/50 flex items-center gap-4 text-xs">
        <span className="text-muted-foreground">{diffs.length} divergent decisions</span>
        <span className={cn('font-medium tabular-nums', totalDelta > 0 ? 'text-emerald-400' : totalDelta < 0 ? 'text-red-400' : 'text-foreground')}>
          Net delta: {totalDelta >= 0 ? '+' : ''}{formatCurrency(totalDelta)}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Message</TableHead>
            <TableHead className="text-center">{runAName}</TableHead>
            <TableHead className="text-center">{runBName}</TableHead>
            <TableHead className="text-right">P&L A</TableHead>
            <TableHead className="text-right">P&L B</TableHead>
            <TableHead className="text-right">Delta</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {diffs.map((d) => (
            <TableRow key={d.messageId}>
              <TableCell className="max-w-[300px]">
                <div className="text-xs text-muted-foreground truncate">
                  {d.message?.author && (
                    <span className="font-medium text-foreground mr-1">{d.message.author}</span>
                  )}
                  {d.message?.cleanText?.slice(0, 80) ?? d.messageId.slice(0, 12)}
                </div>
              </TableCell>
              <TableCell className="text-center">
                <Badge className={d.decisionA === 'EXECUTE' ? 'bg-emerald-900/50 text-emerald-300' : 'bg-zinc-800 text-zinc-400'}>
                  {d.decisionA ?? '--'}
                </Badge>
              </TableCell>
              <TableCell className="text-center">
                <Badge className={d.decisionB === 'EXECUTE' ? 'bg-emerald-900/50 text-emerald-300' : 'bg-zinc-800 text-zinc-400'}>
                  {d.decisionB ?? '--'}
                </Badge>
              </TableCell>
              <TableCell className={cn('text-right tabular-nums text-xs', d.pnlA > 0 ? 'text-emerald-400' : d.pnlA < 0 ? 'text-red-400' : '')}>
                {formatCurrency(d.pnlA)}
              </TableCell>
              <TableCell className={cn('text-right tabular-nums text-xs', d.pnlB > 0 ? 'text-emerald-400' : d.pnlB < 0 ? 'text-red-400' : '')}>
                {formatCurrency(d.pnlB)}
              </TableCell>
              <TableCell className={cn('text-right tabular-nums text-xs font-medium', d.delta > 0 ? 'text-emerald-400' : d.delta < 0 ? 'text-red-400' : '')}>
                {d.delta >= 0 ? '+' : ''}{formatCurrency(d.delta)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

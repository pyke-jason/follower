'use client';

import { useState, useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Check, ChevronsUpDown, FlaskConical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { isRunScopedPath } from '@/lib/run-scope';

type RunItem = {
  id: string;
  name: string | null;
  status: string;
  traders: string[];
  startDate: string;
  endDate: string;
  totalPnl: number | null;
  winRate: number | null;
};

export function RunScopeSelector() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const runId = searchParams.get('run');

  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  // Lazy-fetch runs when popover opens
  useEffect(() => {
    if (!open || fetched) return;
    setLoading(true);
    fetch('/api/backtest-runs')
      .then((r) => r.json())
      .then((data: RunItem[]) => {
        setRuns(data);
        setFetched(true);
      })
      .finally(() => setLoading(false));
  }, [open, fetched]);

  const activeRun = runs.find((r) => r.id === runId);

  function selectRun(id: string | null) {
    setOpen(false);
    if (id === null) {
      // Go live: strip ?run= from current URL
      const params = new URLSearchParams(searchParams.toString());
      params.delete('run');
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
      return;
    }
    // If on an unscoped page, navigate to / first
    const target = isRunScopedPath(pathname) ? pathname : '/';
    const params = new URLSearchParams(searchParams.toString());
    params.set('run', id);
    router.push(`${target}?${params.toString()}`);
  }

  function formatPnl(pnl: number | null): string {
    if (pnl == null) return '';
    const sign = pnl >= 0 ? '+' : '';
    return `${sign}$${pnl.toFixed(0)}`;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className="h-7 gap-2 text-xs font-normal px-2.5"
        >
          {runId ? (
            <>
              <FlaskConical className="h-3.5 w-3.5 text-blue-400" />
              <span className="text-blue-300 max-w-[200px] truncate">
                {activeRun
                  ? activeRun.name || `${activeRun.traders.join(', ')} ${activeRun.startDate}`
                  : `Run ${runId.slice(0, 8)}...`}
              </span>
            </>
          ) : (
            <>
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
              <span>Live</span>
            </>
          )}
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="end">
        <Command>
          <CommandInput placeholder="Search runs..." />
          <CommandList>
            <CommandEmpty>
              {loading ? 'Loading...' : 'No backtest runs found.'}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem value="__live" onSelect={() => selectRun(null)}>
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 mr-2" />
                <span className="flex-1">Live</span>
                <Check
                  className={cn('h-3 w-3', !runId ? 'opacity-100' : 'opacity-0')}
                />
              </CommandItem>
            </CommandGroup>
            {runs.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Backtest Runs">
                  {runs.map((r) => {
                    const label =
                      r.name || `${r.traders.join(', ')} ${r.startDate}`;
                    return (
                      <CommandItem
                        key={r.id}
                        value={`${r.id} ${label}`}
                        onSelect={() => selectRun(r.id)}
                      >
                        <FlaskConical className="h-3.5 w-3.5 text-blue-400 mr-2 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate">{label}</div>
                          <div className="text-xs text-muted-foreground flex gap-2">
                            <span>{r.startDate} &ndash; {r.endDate}</span>
                            {r.winRate != null && (
                              <span>{(r.winRate * 100).toFixed(0)}% WR</span>
                            )}
                            {r.totalPnl != null && (
                              <span
                                className={
                                  r.totalPnl >= 0
                                    ? 'text-emerald-400'
                                    : 'text-red-400'
                                }
                              >
                                {formatPnl(r.totalPnl)}
                              </span>
                            )}
                          </div>
                        </div>
                        <Check
                          className={cn(
                            'h-3 w-3 shrink-0',
                            runId === r.id ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

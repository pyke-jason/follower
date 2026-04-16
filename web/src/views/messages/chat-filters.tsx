import { useMemo } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator } from '@/components/ui/command';
import { getAuthorBgColor, getAuthorTextColor } from '@/lib/author-colors';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CheckIcon, Users, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isoToDateKey } from '@/lib/format';
import { useChatStore } from '@/stores/chat-store';
import { useChatFilterParams } from '@/hooks/use-chat-filter-params';
import type { LabelFilter } from '@/stores/chat-store';

type TimePeriod = 'today' | '7d' | '30d' | 'all';

function getDateRange(period: TimePeriod): { startDate?: string; endDate?: string } {
  if (period === 'all') return {};
  const now = new Date();
  let start: Date;
  if (period === 'today') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === '7d') {
    start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else {
    start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return { startDate: start.toISOString() };
}

type DecisionSummary = {
  processedCount: number;
  executedCount: number;
  skippedCount: number;
};

export function ChatFilters() {
  const storeAuthors = useChatStore((s) => s.authors);
  const constraints = useChatStore((s) => s.constraints);
  const stableDecisionCounts = useChatStore((s) => s.stableDecisionCounts);
  const enrichment = useChatStore((s) => s.enrichment);

  // URL is source of truth for filter values
  const {
    authors: authorsParam,
    start,
    end,
    signals,
    label,
    role,
    setAuthors,
    setStart,
    setEnd,
    setSignals,
    setLabel,
    setRole,
  } = useChatFilterParams();

  const selectedAuthors = useMemo(
    () => (authorsParam ? authorsParam.split(',').filter(Boolean) : []),
    [authorsParam],
  );

  const decisionSummary = useMemo<DecisionSummary | null>(() => {
    if (stableDecisionCounts) return stableDecisionCounts;
    if (!constraints?.channelId) return null;
    if (!enrichment) return null;
    const entries = Object.values(enrichment);
    if (entries.length === 0) return null;
    let executed = 0;
    let skipped = 0;
    for (const e of entries) {
      if (e.decision?.outcome === 'EXECUTE') executed++;
      else if (e.decision?.outcome === 'SKIP') skipped++;
    }
    return { processedCount: executed + skipped, executedCount: executed, skippedCount: skipped };
  }, [stableDecisionCounts, constraints?.channelId, enrichment]);

  const hasDateConstraint = !!(constraints?.startDate && constraints?.endDate);
  const hasAuthorConstraint = !!(constraints?.authors && constraints.authors.length > 0);
  const hasChannelId = !!constraints?.channelId;

  // Derive time period from current start date (only used when no date constraint)
  const timePeriod: TimePeriod = (() => {
    if (!start) return 'all';
    const startMs = new Date(start).getTime();
    const now = Date.now();
    const diff = now - startMs;
    const dayMs = 24 * 60 * 60 * 1000;
    if (diff < 1.5 * dayMs) return 'today';
    if (diff < 10 * dayMs) return '7d';
    if (diff < 35 * dayMs) return '30d';
    return 'all';
  })();

  const handleTimePeriod = (value: string) => {
    if (!value) return;
    const range = getDateRange(value as TimePeriod);
    setStart(range.startDate ?? null);
    setEnd(range.endDate ?? null);
  };

  const toggleAuthor = (author: string) => {
    const next = selectedAuthors.includes(author)
      ? selectedAuthors.filter((a) => a !== author)
      : [...selectedAuthors, author];
    setAuthors(next.length > 0 ? next.join(',') : null);
  };

  const clearAuthors = () => {
    setAuthors(null);
  };

  const toggleSignalsOnly = (checked: boolean) => {
    setSignals(checked || null);
  };

  const handleLabelFilter = (value: string) => {
    setLabel(value || null);
  };

  const handleRoleFilter = (value: string) => {
    if (!value) return;
    setRole(value === 'all' ? null : value);
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-background/80 backdrop-blur-sm flex-wrap sticky top-0 z-10">
      {/* Date scope: locked range label OR time period toggle */}
      {hasDateConstraint ? (
        <span className="text-xs text-muted-foreground tabular-nums">
          {isoToDateKey(constraints!.startDate!)} &ndash; {isoToDateKey(constraints!.endDate!)}
        </span>
      ) : (
        <ToggleGroup
          type="single"
          value={timePeriod}
          onValueChange={handleTimePeriod}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="today" className="text-xs">Today</ToggleGroupItem>
          <ToggleGroupItem value="7d" className="text-xs">7d</ToggleGroupItem>
          <ToggleGroupItem value="30d" className="text-xs">30d</ToggleGroupItem>
          <ToggleGroupItem value="all" className="text-xs">All</ToggleGroupItem>
        </ToggleGroup>
      )}

      <div className="w-px h-5 bg-border" />

      {/* Author scope: locked summary OR author popover */}
      {hasAuthorConstraint ? (
        <ConstraintAuthorsSummary authors={constraints!.authors!} />
      ) : (
        <>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 text-xs text-muted-foreground">
                <Users className="w-3.5 h-3.5" />
                <span>Authors</span>
                {selectedAuthors.length > 0 && (
                  <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-secondary text-secondary-foreground text-[10px] leading-none font-medium">
                    {selectedAuthors.length}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-52 p-0">
              <Command>
                <CommandInput placeholder="Search authors..." className="text-xs" />
                <CommandList>
                  <CommandEmpty className="py-3 text-xs">No authors found</CommandEmpty>
                  {selectedAuthors.length > 0 && (
                    <>
                      <CommandGroup>
                        <CommandItem onSelect={clearAuthors} className="text-muted-foreground text-xs justify-center">
                          Clear authors
                        </CommandItem>
                      </CommandGroup>
                      <CommandSeparator />
                    </>
                  )}
                  <CommandGroup>
                    {storeAuthors.map((author) => {
                      const isSelected = selectedAuthors.includes(author);
                      return (
                        <CommandItem
                          key={author}
                          value={author}
                          onSelect={() => toggleAuthor(author)}
                        >
                          <div className={cn(
                            'flex size-4 items-center justify-center rounded-sm border border-primary',
                            isSelected ? 'bg-primary text-primary-foreground' : 'opacity-50',
                          )}>
                            {isSelected && <CheckIcon className="size-3" />}
                          </div>
                          <span style={{ color: getAuthorTextColor(author) }}>
                            {author}
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          {/* Selected author chips */}
          {selectedAuthors.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {selectedAuthors.slice(0, 3).map((author) => (
                <Button
                  key={author}
                  variant="ghost"
                  size="xs"
                  onClick={() => toggleAuthor(author)}
                  className="inline-flex items-center gap-1 text-[11px] pl-2 pr-1 py-0.5 rounded-full border border-transparent h-auto"
                  style={{
                    backgroundColor: getAuthorBgColor(author),
                    color: 'oklch(0.97 0.008 80)',
                  }}
                >
                  {author}
                  <X className="w-3 h-3 opacity-60 hover:opacity-100" />
                </Button>
              ))}
              {selectedAuthors.length > 3 && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                  +{selectedAuthors.length - 3}
                </span>
              )}
            </div>
          )}
        </>
      )}

      <div className="w-px h-5 bg-border" />

      {/* Decision filters (only when run-scoped) */}
      {hasChannelId && (
        <>
          <ToggleGroup
            type="single"
            value={role || 'all'}
            onValueChange={handleRoleFilter}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="all" className="text-xs">All</ToggleGroupItem>
            <ToggleGroupItem value="processed" className="text-xs">
              With Intent{decisionSummary ? ` (${decisionSummary.processedCount})` : ''}
            </ToggleGroupItem>
            <ToggleGroupItem value="executed" className="text-xs">
              Executed{decisionSummary ? ` (${decisionSummary.executedCount})` : ''}
            </ToggleGroupItem>
            <ToggleGroupItem value="skipped" className="text-xs">
              Skipped{decisionSummary ? ` (${decisionSummary.skippedCount})` : ''}
            </ToggleGroupItem>
          </ToggleGroup>

          <div className="w-px h-5 bg-border" />
        </>
      )}

      {/* Signals only toggle */}
      <div className="flex items-center gap-1.5">
        <Switch
          size="sm"
          checked={signals}
          onCheckedChange={toggleSignalsOnly}
          id="signals-only"
        />
        <Label htmlFor="signals-only" className="text-xs text-muted-foreground cursor-pointer">
          Signals only
        </Label>
      </div>

      <div className="w-px h-5 bg-border" />

      {/* Label filter */}
      <ToggleGroup
        type="single"
        value={label}
        onValueChange={handleLabelFilter}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="labeled" className="text-xs">Labeled</ToggleGroupItem>
        <ToggleGroupItem value="unlabeled" className="text-xs">Unlabeled</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

const AUTHOR_CHIP_LIMIT = 5;

function ConstraintAuthorsSummary({ authors }: { authors: string[] }) {
  if (authors.length <= AUTHOR_CHIP_LIMIT) {
    return (
      <div className="flex items-center gap-1 flex-wrap">
        {authors.map((author) => (
          <span
            key={author}
            className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full"
            style={{
              backgroundColor: getAuthorBgColor(author),
              color: 'oklch(0.97 0.008 80)',
            }}
          >
            {author}
          </span>
        ))}
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-xs text-muted-foreground cursor-default">
          {authors.length} traders
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-80 max-h-60 overflow-y-auto">
        <p className="text-xs leading-relaxed">{authors.join(', ')}</p>
      </TooltipContent>
    </Tooltip>
  );
}

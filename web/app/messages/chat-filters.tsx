'use client';

import { useState, useMemo } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { getAuthorBgColor, getAuthorTextColor } from '@/lib/author-colors';
import { Users, X, Check, Filter } from 'lucide-react';
import type { MessageFilters, LabelFilter } from './actions';
import type { FilterConstraints } from './chat-room';

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

function formatDateCompact(iso: string): string {
  return iso.split('T')[0];
}

type DecisionSummary = {
  executedCount: number;
  skippedCount: number;
  skipReasonCounts: [string, number][];
};

export function ChatFilters({
  authors,
  filters,
  onFilterChange,
  constraints,
  decisionSummary,
}: {
  authors: string[];
  filters: MessageFilters;
  onFilterChange: (filters: MessageFilters) => void;
  constraints?: FilterConstraints;
  decisionSummary?: DecisionSummary | null;
}) {
  const [search, setSearch] = useState('');
  const [selectedReasons, setSelectedReasons] = useState<string[]>([]);

  const hasDateConstraint = !!(constraints?.startDate && constraints?.endDate);
  const hasAuthorConstraint = !!(constraints?.authors && constraints.authors.length > 0);
  const hasRunId = !!constraints?.runId;

  const selectedAuthors = filters.authors ?? [];

  // Derive time period from current startDate (only used when no date constraint)
  const timePeriod: TimePeriod = (() => {
    if (!filters.startDate) return 'all';
    const start = new Date(filters.startDate).getTime();
    const now = Date.now();
    const diff = now - start;
    const dayMs = 24 * 60 * 60 * 1000;
    if (diff < 1.5 * dayMs) return 'today';
    if (diff < 10 * dayMs) return '7d';
    if (diff < 35 * dayMs) return '30d';
    return 'all';
  })();

  const filteredAuthors = useMemo(() => {
    if (!search) return authors;
    const q = search.toLowerCase();
    return authors.filter((a) => a.toLowerCase().includes(q));
  }, [authors, search]);

  const handleTimePeriod = (value: string) => {
    if (!value) return;
    const range = getDateRange(value as TimePeriod);
    onFilterChange({ ...filters, startDate: range.startDate, endDate: range.endDate });
  };

  const toggleAuthor = (author: string) => {
    const next = selectedAuthors.includes(author)
      ? selectedAuthors.filter((a) => a !== author)
      : [...selectedAuthors, author];
    onFilterChange({ ...filters, authors: next.length > 0 ? next : undefined });
  };

  const clearAuthors = () => {
    onFilterChange({ ...filters, authors: undefined });
  };

  const toggleSignalsOnly = (checked: boolean) => {
    onFilterChange({ ...filters, signalsOnly: checked || undefined });
  };

  const handleLabelFilter = (value: string) => {
    onFilterChange({ ...filters, labelFilter: (value || undefined) as LabelFilter | undefined });
  };

  const handleRoleFilter = (value: string) => {
    if (!value) return;
    onFilterChange({
      ...filters,
      roleFilter: value === 'all' ? undefined : (value as 'executed' | 'skipped'),
    });
    setSelectedReasons([]);
  };

  const toggleReason = (reason: string) => {
    setSelectedReasons((prev) =>
      prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason],
    );
  };

  const skipReasons = decisionSummary?.skipReasonCounts ?? [];

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-background/80 backdrop-blur-sm flex-wrap sticky top-0 z-10">
      {/* Date scope: locked range label OR time period toggle */}
      {hasDateConstraint ? (
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDateCompact(constraints!.startDate!)} &ndash; {formatDateCompact(constraints!.endDate!)}
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

      {/* Author scope: locked chips OR author popover */}
      {hasAuthorConstraint ? (
        <div className="flex items-center gap-1 flex-wrap">
          {constraints!.authors!.map((author) => (
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
      ) : (
        <>
          <Popover>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border text-muted-foreground hover:bg-accent transition-colors">
                <Users className="w-3.5 h-3.5" />
                <span>Authors</span>
                {selectedAuthors.length > 0 && (
                  <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-secondary text-secondary-foreground text-[10px] leading-none font-medium">
                    {selectedAuthors.length}
                  </span>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="p-2 border-b border-border">
                <Input
                  placeholder="Search authors..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-7 text-xs"
                />
              </div>
              <div className="max-h-64 overflow-y-auto py-1">
                {filteredAuthors.map((author) => {
                  const isSelected = selectedAuthors.includes(author);
                  return (
                    <button
                      key={author}
                      onClick={() => toggleAuthor(author)}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-accent transition-colors"
                    >
                      <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center flex-shrink-0 ${
                        isSelected ? 'bg-primary border-primary' : 'border-border'
                      }`}>
                        {isSelected && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                      </div>
                      <span
                        className="truncate"
                        style={{ color: getAuthorTextColor(author) }}
                      >
                        {author}
                      </span>
                    </button>
                  );
                })}
                {filteredAuthors.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-3">No authors found</p>
                )}
              </div>
              {selectedAuthors.length > 0 && (
                <div className="border-t border-border p-2">
                  <button
                    onClick={clearAuthors}
                    className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Clear all
                  </button>
                </div>
              )}
            </PopoverContent>
          </Popover>

          {/* Selected author chips */}
          {selectedAuthors.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {selectedAuthors.slice(0, 3).map((author) => (
                <button
                  key={author}
                  onClick={() => toggleAuthor(author)}
                  className="inline-flex items-center gap-1 text-[11px] pl-2 pr-1 py-0.5 rounded-full border border-transparent transition-colors"
                  style={{
                    backgroundColor: getAuthorBgColor(author),
                    color: 'oklch(0.97 0.008 80)',
                  }}
                >
                  {author}
                  <X className="w-3 h-3 opacity-60 hover:opacity-100" />
                </button>
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
      {hasRunId && (
        <>
          <ToggleGroup
            type="single"
            value={filters.roleFilter ?? 'all'}
            onValueChange={handleRoleFilter}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="all" className="text-xs">All</ToggleGroupItem>
            <ToggleGroupItem value="executed" className="text-xs">
              Executed{decisionSummary ? ` (${decisionSummary.executedCount})` : ''}
            </ToggleGroupItem>
            <ToggleGroupItem value="skipped" className="text-xs">
              Skipped{decisionSummary ? ` (${decisionSummary.skippedCount})` : ''}
            </ToggleGroupItem>
          </ToggleGroup>

          {/* Skip reason filter popover */}
          {skipReasons.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <button className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border text-muted-foreground hover:bg-accent transition-colors">
                  <Filter className="w-3.5 h-3.5" />
                  <span>Skip Reasons</span>
                  {selectedReasons.length > 0 && (
                    <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-secondary text-secondary-foreground text-[10px] leading-none font-medium">
                      {selectedReasons.length}
                    </span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-0">
                <div className="max-h-64 overflow-y-auto py-1">
                  {skipReasons.map(([reason, count]) => {
                    const isSelected = selectedReasons.includes(reason);
                    return (
                      <button
                        key={reason}
                        onClick={() => toggleReason(reason)}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-accent transition-colors"
                      >
                        <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center flex-shrink-0 ${
                          isSelected ? 'bg-primary border-primary' : 'border-border'
                        }`}>
                          {isSelected && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                        </div>
                        <span className="truncate text-muted-foreground">{reason}</span>
                        <span className="ml-auto text-muted-foreground/60 tabular-nums">{count}</span>
                      </button>
                    );
                  })}
                </div>
                {selectedReasons.length > 0 && (
                  <div className="border-t border-border p-2">
                    <button
                      onClick={() => setSelectedReasons([])}
                      className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Clear all
                    </button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          )}

          {/* Selected reason chips */}
          {selectedReasons.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {selectedReasons.slice(0, 2).map((reason) => (
                <button
                  key={reason}
                  onClick={() => toggleReason(reason)}
                  className="inline-flex items-center gap-1 text-[11px] pl-2 pr-1 py-0.5 rounded-full bg-secondary text-muted-foreground"
                >
                  {reason.length > 25 ? reason.slice(0, 22) + '...' : reason}
                  <span className="opacity-60 hover:opacity-100 ml-0.5">&times;</span>
                </button>
              ))}
              {selectedReasons.length > 2 && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                  +{selectedReasons.length - 2}
                </span>
              )}
            </div>
          )}

          <div className="w-px h-5 bg-border" />
        </>
      )}

      {/* Signals only toggle */}
      <div className="flex items-center gap-1.5">
        <Switch
          size="sm"
          checked={filters.signalsOnly ?? false}
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
        value={filters.labelFilter ?? ''}
        onValueChange={handleLabelFilter}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="labeled" className="text-xs">Labeled</ToggleGroupItem>
        <ToggleGroupItem value="unlabeled" className="text-xs">Unlabeled</ToggleGroupItem>
        <ToggleGroupItem value="mismatched" className="text-xs">Mismatched</ToggleGroupItem>
        <ToggleGroupItem value="needs-review" className="text-xs">Needs Review</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

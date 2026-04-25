import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator } from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { CheckIcon, ChevronsUpDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { createFilterParams } from '@/hooks/use-filter-params';
import { TRADE_FLAGS } from '@src/db/schema';
import type { TradeFlag } from '@src/db/schema';
import type { TradeRowWithQuality } from '@/lib/page-adapters';
import type { EvalSummary } from '@src/local-api/http-schemas';

// ── Filter values ──────────────────────────────────────────────────


const FLAG_LABELS: Partial<Record<TradeFlag, string>> = {
  closeFailed: 'Close failed',
  autoClose: 'Auto-close',
  legOff: 'Leg off',
  trim: 'Trimmed',
  add: 'Added',
  slippage: 'Slippage',
  marketDataFail: 'Market data fail',
  chaseWarn: 'Chase warn',
  chaseDanger: 'Chase danger',
  hasUpdate: 'Has update',
};

type LabelBucket = 'tp' | 'fp' | 'unlabeled';

type MultiFilterKey = 'statuses' | 'traders' | 'symbols' | 'strategies' | 'directions' | 'flags' | 'labelBuckets';

interface TradeFilterValues {
  statuses: string[];
  traders: string[];
  symbols: string[];
  strategies: string[];
  directions: string[];
  flags: TradeFlag[];
  labelBuckets: LabelBucket[];
}

function applyTradeFilters(
  trades: TradeRowWithQuality[],
  filters: TradeFilterValues,
  flagsByTradeId?: Record<string, TradeFlag[]>,
  labelsByTradeId?: Record<string, { bucket: string }>,
): TradeRowWithQuality[] {
  return trades.filter((t) => {
    if (filters.statuses.length > 0 && !filters.statuses.includes(t.status)) return false;
    if (filters.traders.length > 0 && !filters.traders.includes(t.trader)) return false;
    if (filters.symbols.length > 0 && !filters.symbols.includes(t.symbol)) return false;
    if (filters.strategies.length > 0 && !filters.strategies.includes(t.strategy)) return false;
    if (filters.directions.length > 0 && !filters.directions.includes(t.direction)) return false;
    if (filters.flags.length > 0 && flagsByTradeId) {
      const tradeFlags = flagsByTradeId[t.id] ?? [];
      if (!filters.flags.some(f => tradeFlags.includes(f))) return false;
    }
    if (filters.labelBuckets.length > 0 && labelsByTradeId) {
      const bucket = labelsByTradeId[t.id]?.bucket ?? 'unlabeled';
      if (!filters.labelBuckets.includes(bucket as LabelBucket)) return false;
    }
    return true;
  });
}

// ── URL-synced filter params ───────────────────────────────────────

const useTradeFilterParams = createFilterParams({
  statuses:     { type: 'string[]' },
  traders:      { type: 'string[]' },
  symbols:      { type: 'string[]' },
  strategies:   { type: 'string[]' },
  directions:   { type: 'string[]' },
  flags:        { type: 'string[]' },
  labelBuckets: { type: 'string[]' },
});

// ── Context ────────────────────────────────────────────────────────

interface TradeFilterContextValue {
  filters: TradeFilterValues;
  toggle: (key: MultiFilterKey, value: string) => void;
  setStatuses: (statuses: string[] | null) => void;
  clearKey: (key: MultiFilterKey) => void;
  clearFilters: () => void;
  hasFilters: boolean;
  allTrades: TradeRowWithQuality[];
  filteredTrades: TradeRowWithQuality[];
  availableFlags: TradeFlag[];
  labelsByTradeId?: Record<string, { bucket: string }>;
}

const TradeFilterContext = createContext<TradeFilterContextValue | null>(null);

export function TradeFilterProvider({
  trades,
  flagsByTradeId,
  labelsByTradeId,
  children,
}: {
  trades: TradeRowWithQuality[];
  flagsByTradeId?: Record<string, TradeFlag[]>;
  labelsByTradeId?: Record<string, { bucket: string }>;
  children: ReactNode;
}) {
  const params = useTradeFilterParams();

  const filters: TradeFilterValues = useMemo(() => ({
    statuses: params.statuses,
    traders: params.traders,
    symbols: params.symbols,
    strategies: params.strategies,
    directions: params.directions,
    flags: params.flags as TradeFlag[],
    labelBuckets: params.labelBuckets as LabelBucket[],
  }), [params.statuses, params.traders, params.symbols, params.strategies, params.directions, params.flags, params.labelBuckets]);

  const toggle = useCallback((key: MultiFilterKey, value: string) => {
    const arr = filters[key] as string[];
    const next = arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
    const setters: Record<MultiFilterKey, (v: string[] | null) => void> = {
      statuses: params.setStatuses,
      traders: params.setTraders,
      symbols: params.setSymbols,
      strategies: params.setStrategies,
      directions: params.setDirections,
      flags: params.setFlags,
      labelBuckets: params.setLabelBuckets,
    };
    setters[key](next);
  }, [filters, params.setStatuses, params.setTraders, params.setSymbols, params.setStrategies, params.setDirections, params.setFlags, params.setLabelBuckets]);

  const clearKey = useCallback((key: MultiFilterKey) => {
    const setters: Record<MultiFilterKey, (v: string[] | null) => void> = {
      statuses: params.setStatuses,
      traders: params.setTraders,
      symbols: params.setSymbols,
      strategies: params.setStrategies,
      directions: params.setDirections,
      flags: params.setFlags,
      labelBuckets: params.setLabelBuckets,
    };
    setters[key](null);
  }, [params.setStatuses, params.setTraders, params.setSymbols, params.setStrategies, params.setDirections, params.setFlags, params.setLabelBuckets]);

  const hasFilters = params.hasFilters;
  const clearFilters = params.clearFilters;

  const filteredTrades = useMemo(
    () => applyTradeFilters(trades, filters, flagsByTradeId, labelsByTradeId),
    [trades, filters, flagsByTradeId, labelsByTradeId],
  );

  // Only show flag toggles for flags that actually appear on at least one trade
  const availableFlags = useMemo(() => {
    if (!flagsByTradeId) return [];
    const seen = new Set<TradeFlag>();
    for (const flags of Object.values(flagsByTradeId)) {
      for (const f of flags) seen.add(f);
    }
    return ([...TRADE_FLAGS] as TradeFlag[]).filter(f => seen.has(f));
  }, [flagsByTradeId]);

  const value = useMemo(
    () => ({
      filters,
      toggle,
      setStatuses: params.setStatuses,
      clearKey,
      clearFilters,
      hasFilters,
      allTrades: trades,
      filteredTrades,
      availableFlags,
      labelsByTradeId,
    }),
    [filters, toggle, params.setStatuses, clearKey, clearFilters, hasFilters, trades, filteredTrades, availableFlags, labelsByTradeId],
  );

  return <TradeFilterContext value={value}>{children}</TradeFilterContext>;
}

export function useTradeFilters() {
  const ctx = useContext(TradeFilterContext);
  if (!ctx) throw new Error('useTradeFilters must be used within TradeFilterProvider');
  return ctx;
}

// ── Multi-select combobox ───────────────────────────────────────────

function MultiSelect({
  selected,
  onToggle,
  onClear,
  options,
  label,
  labels,
  searchable,
  minWidth,
}: {
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
  options: string[];
  label: string;
  labels?: Record<string, string>;
  searchable?: boolean;
  minWidth?: string;
}) {
  const [open, setOpen] = useState(false);

  if (options.length <= 1) return null;

  const displayLabel = (opt: string) => labels?.[opt] ?? opt;
  const count = selected.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-7 text-xs px-2 gap-1 font-normal shadow-xs',
            !count && 'text-muted-foreground',
          )}
          style={minWidth ? { minWidth } : undefined}
        >
          <span className="truncate">{label}</span>
          <span className={cn(
            'text-[10px] leading-none px-1 py-0.5 rounded-sm font-medium min-w-[1ch] text-center',
            count > 0 ? 'bg-primary text-primary-foreground' : 'invisible',
          )}>
            {count || 0}
          </span>
          <ChevronsUpDown className="size-3 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-0" align="start">
        <Command>
          {searchable && <CommandInput placeholder={`Search ${label.toLowerCase()}...`} className="text-xs" />}
          <CommandList>
            {searchable && <CommandEmpty className="py-3 text-xs">No match</CommandEmpty>}
            {count > 0 && (
              <>
                <CommandGroup>
                  <CommandItem onSelect={onClear} className="text-muted-foreground text-xs justify-center">
                    Clear {label.toLowerCase()}
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            <CommandGroup>
              {options.map((opt) => {
                const isSelected = selected.includes(opt);
                return (
                  <CommandItem
                    key={opt}
                    value={opt}
                    onSelect={() => onToggle(opt)}
                  >
                    <div className={cn(
                      'flex size-4 items-center justify-center rounded-sm border border-primary',
                      isSelected ? 'bg-primary text-primary-foreground' : 'opacity-50',
                    )}>
                      {isSelected && <CheckIcon className="size-3" />}
                    </div>
                    {displayLabel(opt)}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── TradeFilters UI ────────────────────────────────────────────────

const LABEL_BUCKET_LABELS: Record<string, string> = {
  tp: 'Correct (TP)',
  fp: 'Wrong (FP)',
  unlabeled: 'No label',
};

const STATUS_LABELS: Record<string, string> = {
  OPEN: 'Open',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

export function TradeFilters({ className, evalSummary }: { className?: string; evalSummary?: EvalSummary }) {
  const { filters, toggle, setStatuses, clearKey, clearFilters, hasFilters, allTrades, filteredTrades, availableFlags, labelsByTradeId } = useTradeFilters();

  const options = useMemo(() => ({
    statuses: ['OPEN', 'CLOSED', 'CANCELLED'].filter((status) => allTrades.some((t) => t.status === status)),
    traders: [...new Set(allTrades.map((t) => t.trader))].sort(),
    symbols: [...new Set(allTrades.map((t) => t.symbol))].sort(),
    strategies: [...new Set(allTrades.map((t) => t.strategy))].sort(),
    directions: [...new Set(allTrades.map((t) => t.direction))].sort(),
  }), [allTrades]);

  const statusToggleValue = useMemo(() => {
    if (filters.statuses.length !== 1) return 'ALL';
    return filters.statuses[0];
  }, [filters.statuses]);

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={statusToggleValue}
        onValueChange={(value) => {
          if (!value || value === 'ALL') {
            setStatuses(null);
            return;
          }
          setStatuses([value]);
        }}
      >
        <ToggleGroupItem value="ALL" className="h-7 text-xs px-2">All</ToggleGroupItem>
        {options.statuses.map((status) => (
          <ToggleGroupItem key={status} value={status} className="h-7 text-xs px-2">
            {STATUS_LABELS[status] ?? status}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <MultiSelect selected={filters.traders} onToggle={(v) => toggle('traders', v)} onClear={() => clearKey('traders')} options={options.traders} label="Trader" />
      <MultiSelect selected={filters.symbols} onToggle={(v) => toggle('symbols', v)} onClear={() => clearKey('symbols')} options={options.symbols} label="Symbol" searchable />
      <MultiSelect selected={filters.strategies} onToggle={(v) => toggle('strategies', v)} onClear={() => clearKey('strategies')} options={options.strategies} label="Strategy" />
      <MultiSelect selected={filters.directions} onToggle={(v) => toggle('directions', v)} onClear={() => clearKey('directions')} options={options.directions} label="Direction" />
      {availableFlags.length > 0 && (
        <MultiSelect
          selected={filters.flags}
          onToggle={(v) => toggle('flags', v)}
          onClear={() => clearKey('flags')}
          options={availableFlags}
          label="Flags"
          labels={FLAG_LABELS as Record<string, string>}
        />
      )}
      {labelsByTradeId && Object.keys(labelsByTradeId).length > 0 && (
        <MultiSelect
          selected={filters.labelBuckets}
          onToggle={(v) => toggle('labelBuckets', v)}
          onClear={() => clearKey('labelBuckets')}
          options={['tp', 'fp', 'unlabeled']}
          label="Label"
          labels={LABEL_BUCKET_LABELS}
        />
      )}
      {evalSummary && (
        <div className="flex items-center gap-2 ml-1 text-xs text-muted-foreground">
          <span className="text-[10px] uppercase tracking-wide">Acc</span>
          <span className="font-mono font-semibold tabular-nums text-foreground">{(evalSummary.metrics.accuracy * 100).toFixed(0)}%</span>
          <span className="text-border">|</span>
          <span className="text-[10px] uppercase tracking-wide">P</span>
          <span className="font-mono font-semibold tabular-nums text-foreground">{(evalSummary.metrics.precision * 100).toFixed(0)}%</span>
          <span className="text-border">|</span>
          <span className="text-[10px] uppercase tracking-wide">R</span>
          <span className="font-mono font-semibold tabular-nums text-foreground">{(evalSummary.metrics.recall * 100).toFixed(0)}%</span>
          <span className="text-border">|</span>
          <span className="text-[10px] uppercase tracking-wide">F1</span>
          <span className="font-mono font-semibold tabular-nums text-foreground">{evalSummary.metrics.f1.toFixed(2)}</span>
          {evalSummary.unlabeled > 0 && (
            <Badge
              variant={evalSummary.unlabeled / (evalSummary.labeled + evalSummary.unlabeled) > 0.2 ? 'destructive' : 'secondary'}
              className={evalSummary.unlabeled / (evalSummary.labeled + evalSummary.unlabeled) <= 0.2 ? 'bg-warning/15 text-warning text-[10px]' : 'text-[10px]'}
            >
              {evalSummary.unlabeled} unlabeled
            </Badge>
          )}
        </div>
      )}
      {(() => {
        const digits = String(allTrades.length).length;
        // "{digits} / {digits}" = digits*2 + 3 chars for " / ", plus icon + gaps
        const minWidth = `calc(${digits * 2 + 3}ch + 1rem)`;
        return (
          <Button
            variant="ghost"
            size="xs"
            onClick={clearFilters}
            disabled={!hasFilters}
            className={cn(
              'px-1 justify-end tabular-nums whitespace-nowrap shrink-0',
              hasFilters ? 'text-muted-foreground hover:text-foreground' : 'text-muted-foreground/40',
            )}
            style={{ minWidth }}
          >
            {filteredTrades.length} / {allTrades.length}
            <X className={cn('size-3 shrink-0', !hasFilters && 'invisible')} />
          </Button>
        );
      })()}
    </div>
  );
}

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator } from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { CheckIcon, ChevronsUpDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TRADE_FLAGS } from '@src/db/schema';
import type { Trade, TradeFlag } from '@src/db/schema';

// ── Filter values ──────────────────────────────────────────────────

export type { TradeFlag };

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

type MultiFilterKey = 'traders' | 'symbols' | 'strategies' | 'directions' | 'flags';

export interface TradeFilterValues {
  traders: string[];
  symbols: string[];
  strategies: string[];
  directions: string[];
  flags: TradeFlag[];
}

const EMPTY_FILTERS: TradeFilterValues = {
  traders: [],
  symbols: [],
  strategies: [],
  directions: [],
  flags: [],
};

export function applyTradeFilters(
  trades: Trade[],
  filters: TradeFilterValues,
  flagsByTradeId?: Record<string, TradeFlag[]>,
): Trade[] {
  return trades.filter((t) => {
    if (filters.traders.length > 0 && !filters.traders.includes(t.trader)) return false;
    if (filters.symbols.length > 0 && !filters.symbols.includes(t.symbol)) return false;
    if (filters.strategies.length > 0 && !filters.strategies.includes(t.strategy)) return false;
    if (filters.directions.length > 0 && !filters.directions.includes(t.direction)) return false;
    if (filters.flags.length > 0 && flagsByTradeId) {
      const tradeFlags = flagsByTradeId[t.id] ?? [];
      if (!filters.flags.some(f => tradeFlags.includes(f))) return false;
    }
    return true;
  });
}

// ── Context ────────────────────────────────────────────────────────

interface TradeFilterContextValue {
  filters: TradeFilterValues;
  toggle: (key: MultiFilterKey, value: string) => void;
  clearKey: (key: MultiFilterKey) => void;
  clearFilters: () => void;
  hasFilters: boolean;
  allTrades: Trade[];
  filteredTrades: Trade[];
  availableFlags: TradeFlag[];
}

const TradeFilterContext = createContext<TradeFilterContextValue | null>(null);

export function TradeFilterProvider({
  trades,
  flagsByTradeId,
  children,
}: {
  trades: Trade[];
  flagsByTradeId?: Record<string, TradeFlag[]>;
  children: ReactNode;
}) {
  const [filters, setFilters] = useState<TradeFilterValues>(EMPTY_FILTERS);

  const toggle = useCallback((key: MultiFilterKey, value: string) => {
    setFilters((prev) => {
      const arr = prev[key] as string[];
      return { ...prev, [key]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value] };
    });
  }, []);

  const clearKey = useCallback((key: MultiFilterKey) => {
    setFilters((prev) => ({ ...prev, [key]: [] }));
  }, []);

  const clearFilters = useCallback(() => setFilters(EMPTY_FILTERS), []);
  const hasFilters = filters.traders.length > 0 || filters.symbols.length > 0 || filters.strategies.length > 0 || filters.directions.length > 0 || filters.flags.length > 0;

  const filteredTrades = useMemo(
    () => applyTradeFilters(trades, filters, flagsByTradeId),
    [trades, filters, flagsByTradeId],
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
    () => ({ filters, toggle, clearKey, clearFilters, hasFilters, allTrades: trades, filteredTrades, availableFlags }),
    [filters, toggle, clearKey, clearFilters, hasFilters, trades, filteredTrades, availableFlags],
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

export function TradeFilters({ className }: { className?: string }) {
  const { filters, toggle, clearKey, clearFilters, hasFilters, allTrades, filteredTrades, availableFlags } = useTradeFilters();

  const options = useMemo(() => ({
    traders: [...new Set(allTrades.map((t) => t.trader))].sort(),
    symbols: [...new Set(allTrades.map((t) => t.symbol))].sort(),
    strategies: [...new Set(allTrades.map((t) => t.strategy))].sort(),
    directions: [...new Set(allTrades.map((t) => t.direction))].sort(),
  }), [allTrades]);

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
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
      {(() => {
        const digits = String(allTrades.length).length;
        // "{digits} / {digits}" = digits*2 + 3 chars for " / ", plus icon + gaps
        const minWidth = `calc(${digits * 2 + 3}ch + 1rem)`;
        return (
          <button
            type="button"
            onClick={clearFilters}
            disabled={!hasFilters}
            className={cn(
              'h-7 text-xs px-1 gap-1 inline-flex items-center justify-end tabular-nums whitespace-nowrap shrink-0',
              hasFilters ? 'text-muted-foreground hover:text-foreground' : 'text-muted-foreground/40 pointer-events-none',
            )}
            style={{ minWidth }}
          >
            {filteredTrades.length} / {allTrades.length}
            <X className={cn('size-3 shrink-0', !hasFilters && 'invisible')} />
          </button>
        );
      })()}
    </div>
  );
}

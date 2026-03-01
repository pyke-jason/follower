'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { CheckIcon, ChevronsUpDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Trade } from '../../../src/db/schema';

// ── Filter values ──────────────────────────────────────────────────

export interface TradeFilterValues {
  traders: string[];
  symbol: string;
  strategies: string[];
  directions: string[];
}

const EMPTY_FILTERS: TradeFilterValues = {
  traders: [],
  symbol: '',
  strategies: [],
  directions: [],
};

export function applyTradeFilters(trades: Trade[], filters: TradeFilterValues): Trade[] {
  return trades.filter((t) => {
    if (filters.traders.length > 0 && !filters.traders.includes(t.trader)) return false;
    if (filters.symbol && !t.symbol.toLowerCase().includes(filters.symbol.toLowerCase())) return false;
    if (filters.strategies.length > 0 && !filters.strategies.includes(t.strategy)) return false;
    if (filters.directions.length > 0 && !filters.directions.includes(t.direction)) return false;
    return true;
  });
}

// ── Context ────────────────────────────────────────────────────────

interface TradeFilterContextValue {
  filters: TradeFilterValues;
  setFilters: (f: TradeFilterValues) => void;
  toggleMulti: (key: 'traders' | 'strategies' | 'directions', value: string) => void;
  setSymbol: (value: string) => void;
  clearFilters: () => void;
  hasFilters: boolean;
  allTrades: Trade[];
  filteredTrades: Trade[];
}

const TradeFilterContext = createContext<TradeFilterContextValue | null>(null);

export function TradeFilterProvider({ trades, children }: { trades: Trade[]; children: ReactNode }) {
  const [filters, setFilters] = useState<TradeFilterValues>(EMPTY_FILTERS);

  const toggleMulti = useCallback((key: 'traders' | 'strategies' | 'directions', value: string) => {
    setFilters((prev) => {
      const arr = prev[key];
      return { ...prev, [key]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value] };
    });
  }, []);

  const setSymbol = useCallback((value: string) => {
    setFilters((prev) => ({ ...prev, symbol: value }));
  }, []);

  const clearFilters = useCallback(() => setFilters(EMPTY_FILTERS), []);
  const hasFilters = filters.traders.length > 0 || filters.symbol !== '' || filters.strategies.length > 0 || filters.directions.length > 0;

  const filteredTrades = useMemo(
    () => applyTradeFilters(trades, filters),
    [trades, filters],
  );

  const value = useMemo(
    () => ({ filters, setFilters, toggleMulti, setSymbol, clearFilters, hasFilters, allTrades: trades, filteredTrades }),
    [filters, toggleMulti, setSymbol, clearFilters, hasFilters, trades, filteredTrades],
  );

  return <TradeFilterContext value={value}>{children}</TradeFilterContext>;
}

export function useTradeFilters() {
  const ctx = useContext(TradeFilterContext);
  if (!ctx) throw new Error('useTradeFilters must be used within TradeFilterProvider');
  return ctx;
}

// ── Multi-select popover ───────────────────────────────────────────

function MultiSelect({
  selected,
  onToggle,
  options,
  label,
}: {
  selected: string[];
  onToggle: (value: string) => void;
  options: string[];
  label: string;
}) {
  const [open, setOpen] = useState(false);

  if (options.length <= 1) return null;

  const hasSelection = selected.length > 0;
  const triggerLabel = hasSelection
    ? selected.length === 1
      ? selected[0]
      : `${selected.length} ${label.toLowerCase()}`
    : label;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-7 text-xs px-2 gap-1 font-normal shadow-xs',
            !hasSelection && 'text-muted-foreground',
          )}
        >
          {triggerLabel}
          <ChevronsUpDown className="size-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-0" align="start">
        <Command>
          <CommandList>
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
                    {opt}
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

// ── Symbol combobox ────────────────────────────────────────────────

function SymbolCombobox({
  value,
  onChange,
  symbols,
}: {
  value: string;
  onChange: (v: string) => void;
  symbols: string[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-7 w-24 text-xs px-2 gap-1 font-normal justify-between shadow-xs',
            !value && 'text-muted-foreground',
          )}
        >
          <span className="truncate">{value || 'Symbol'}</span>
          <ChevronsUpDown className="size-3 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search symbol..." className="text-xs" />
          <CommandList>
            <CommandEmpty className="py-3 text-xs">No match</CommandEmpty>
            <CommandGroup>
              {value && (
                <CommandItem value="__clear__" onSelect={() => onChange('')} className="text-muted-foreground">
                  Clear
                </CommandItem>
              )}
              {symbols.map((sym) => (
                <CommandItem
                  key={sym}
                  value={sym}
                  onSelect={() => onChange(sym === value ? '' : sym)}
                >
                  <CheckIcon className={cn('size-3 mr-1', value === sym ? 'opacity-100' : 'opacity-0')} />
                  {sym}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── TradeFilters UI ────────────────────────────────────────────────

export function TradeFilters({ className }: { className?: string }) {
  const { filters, toggleMulti, setSymbol, clearFilters, hasFilters, allTrades, filteredTrades } = useTradeFilters();

  const options = useMemo(() => ({
    traders: [...new Set(allTrades.map((t) => t.trader))].sort(),
    symbols: [...new Set(allTrades.map((t) => t.symbol))].sort(),
    strategies: [...new Set(allTrades.map((t) => t.strategy))].sort(),
    directions: [...new Set(allTrades.map((t) => t.direction))].sort(),
  }), [allTrades]);

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <MultiSelect selected={filters.traders} onToggle={(v) => toggleMulti('traders', v)} options={options.traders} label="Trader" />
      <SymbolCombobox value={filters.symbol} onChange={setSymbol} symbols={options.symbols} />
      <MultiSelect selected={filters.strategies} onToggle={(v) => toggleMulti('strategies', v)} options={options.strategies} label="Strategy" />
      <MultiSelect selected={filters.directions} onToggle={(v) => toggleMulti('directions', v)} options={options.directions} label="Direction" />
      {/* Always reserve space for count + clear to prevent layout shift */}
      <span className={cn('text-xs tabular-nums min-w-[4ch] text-right', hasFilters ? 'text-muted-foreground' : 'invisible')}>
        {filteredTrades.length}/{allTrades.length}
      </span>
      <Button
        variant="ghost"
        size="icon"
        onClick={clearFilters}
        className={cn('h-6 w-6 text-muted-foreground hover:text-foreground', !hasFilters && 'invisible')}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}

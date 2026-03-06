import {
  useState,
  useOptimistic,
  useTransition,
  useEffect,
  useCallback,
  memo,
} from 'react';
import { Link } from 'react-router-dom';
import { Search, X, Plus, ListPlus, Trash2 } from 'lucide-react';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { TrackedTrader } from '@src/db/schema';
import { api } from '@/lib/api';

const quickAdd = (name: string) =>
  api('/traders', { method: 'POST', body: JSON.stringify({ name }) });
const removeTrader = (name: string) =>
  api(`/traders/${encodeURIComponent(name)}`, { method: 'DELETE' });
const toggleEnabled = (name: string, currentlyEnabled: boolean) =>
  api(`/traders/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify({ field: 'enabled', value: !currentlyEnabled }),
  });
const setStrategies = (name: string, strategies: string[]) =>
  api(`/traders/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify({ field: 'strategies', value: strategies }),
  });
const setNotes = (name: string, notes: string | null) =>
  api(`/traders/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify({ field: 'notes', value: notes }),
  });
const setRiskPercent = (name: string, riskPercent: number | null) =>
  api(`/traders/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify({ field: 'riskPercent', value: riskPercent }),
  });
const bulkAdd = (names: string[]) =>
  api('/traders/bulk', { method: 'POST', body: JSON.stringify({ action: 'add', names }) });
const bulkRemove = (names: string[]) =>
  api('/traders/bulk', { method: 'POST', body: JSON.stringify({ action: 'remove', names }) });
const bulkToggleStrategy = (names: string[], strategy: string, enable: boolean) =>
  api('/traders/bulk', { method: 'POST', body: JSON.stringify({ action: 'toggleStrategy', names, strategy, enable }) });

const ALL_STRATEGIES = ['CDS', 'PDS', 'CALL', 'PUT', 'STOCK'] as const;

const STRAT_OFF =
  'data-[state=off]:!text-muted-foreground/25 data-[state=off]:line-through';
const STRAT_CLASSES: Record<string, string> = {
  CDS: `data-[state=on]:!bg-amber-500/15 data-[state=on]:!text-amber-800 dark:data-[state=on]:!text-amber-300 ${STRAT_OFF}`,
  PDS: `data-[state=on]:!bg-violet-500/15 data-[state=on]:!text-violet-800 dark:data-[state=on]:!text-violet-300 ${STRAT_OFF}`,
  CALL: `data-[state=on]:!bg-emerald-500/15 data-[state=on]:!text-emerald-800 dark:data-[state=on]:!text-emerald-300 ${STRAT_OFF}`,
  PUT: `data-[state=on]:!bg-rose-500/15 data-[state=on]:!text-rose-800 dark:data-[state=on]:!text-rose-300 ${STRAT_OFF}`,
  STOCK: `data-[state=on]:!bg-sky-500/15 data-[state=on]:!text-sky-800 dark:data-[state=on]:!text-sky-300 ${STRAT_OFF}`,
};

const BULK_ON: Record<string, string> = {
  CDS: 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-400/40',
  PDS: 'bg-violet-500/15 text-violet-800 dark:text-violet-300 border-violet-400/40',
  CALL: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-400/40',
  PUT: 'bg-rose-500/15 text-rose-800 dark:text-rose-300 border-rose-400/40',
  STOCK: 'bg-sky-500/15 text-sky-800 dark:text-sky-300 border-sky-400/40',
};

type OptAction =
  | { type: 'add'; name: string }
  | { type: 'addAll'; names: string[] }
  | { type: 'remove'; name: string }
  | { type: 'removeAll'; names: string[] }
  | { type: 'toggle'; name: string }
  | { type: 'strategies'; name: string; strategies: string[] }
  | {
      type: 'bulkStrategy';
      names: string[];
      strategy: string;
      enable: boolean;
    }
  | { type: 'riskPercent'; name: string; riskPercent: number | null };

export function TraderRoster({
  traders,
  authors,
}: {
  traders: TrackedTrader[];
  authors: string[];
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const [optimistic, addOptimistic] = useOptimistic(
    traders,
    (state: TrackedTrader[], action: OptAction): TrackedTrader[] => {
      switch (action.type) {
        case 'add':
          return [
            ...state,
            {
              name: action.name,
              enabled: true,
              strategies: [...ALL_STRATEGIES],
              notes: null,
              positionSizingConfig: null,
            },
          ];
        case 'addAll':
          return [
            ...state,
            ...action.names.map((name) => ({
              name,
              enabled: true as boolean | null,
              strategies: [...ALL_STRATEGIES],
              notes: null as string | null,
              positionSizingConfig:
                null as TrackedTrader['positionSizingConfig'],
            })),
          ];
        case 'remove':
          return state.filter((t) => t.name !== action.name);
        case 'removeAll':
          return state.filter((t) => !action.names.includes(t.name));
        case 'toggle':
          return state.map((t) =>
            t.name === action.name ? { ...t, enabled: !t.enabled } : t,
          );
        case 'strategies':
          return state.map((t) =>
            t.name === action.name
              ? { ...t, strategies: action.strategies }
              : t,
          );
        case 'bulkStrategy':
          return state.map((t) => {
            if (!action.names.includes(t.name)) return t;
            const current = t.strategies;
            const strategies = action.enable
              ? current.includes(action.strategy)
                ? current
                : [...current, action.strategy]
              : current.filter((s) => s !== action.strategy);
            return { ...t, strategies };
          });
        case 'riskPercent':
          return state.map((t) =>
            t.name === action.name
              ? {
                  ...t,
                  positionSizingConfig: action.riskPercent != null
                    ? {
                        strategy: 'atr' as const,
                        riskPercent: action.riskPercent,
                        atrMultiplier: (t.positionSizingConfig?.strategy === 'atr' ? t.positionSizingConfig.atrMultiplier : 2.0),
                      }
                    : null,
                }
              : t,
          );
      }
    },
  );

  // / to open search, Escape to clear selection
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        setAddOpen(true);
      }
      if (e.key === 'Escape') {
        setSelected(new Set());
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const trackedSet = new Set(optimistic.map((t) => t.name));
  const available = authors.filter((a) => !trackedSet.has(a));

  // Derive pruned selection inline — no effect needed
  const active = new Set([...selected].filter((n) => trackedSet.has(n)));
  const allSelected =
    optimistic.length > 0 && active.size === optimistic.length;
  const someSelected = active.size > 0 && !allSelected;

  // Stable callbacks for TraderRow — take name/trader as argument
  const toggleSelect = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  function toggleSelectAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(optimistic.map((t) => t.name)));
    }
  }

  function doAdd(name: string) {
    setAddOpen(false);
    startTransition(async () => {
      addOptimistic({ type: 'add', name });
      await quickAdd(name);
    });
  }

  function doAddAll() {
    if (!available.length) return;
    setAddOpen(false);
    startTransition(async () => {
      addOptimistic({ type: 'addAll', names: available });
      await bulkAdd(available);
    });
  }

  const doRemove = useCallback(
    (name: string) => {
      startTransition(async () => {
        addOptimistic({ type: 'remove', name });
        await removeTrader(name);
      });
    },
    [addOptimistic, startTransition],
  );

  function doRemoveSelected() {
    const names = [...active];
    if (!names.length) return;
    setSelected(new Set());
    startTransition(async () => {
      addOptimistic({ type: 'removeAll', names });
      await bulkRemove(names);
    });
  }

  function doRemoveAll() {
    const names = optimistic.map((t) => t.name);
    if (!names.length) return;
    setSelected(new Set());
    startTransition(async () => {
      addOptimistic({ type: 'removeAll', names });
      await bulkRemove(names);
    });
  }

  const doToggle = useCallback(
    (name: string, enabled: boolean) => {
      startTransition(async () => {
        addOptimistic({ type: 'toggle', name });
        await toggleEnabled(name, enabled);
      });
    },
    [addOptimistic, startTransition],
  );

  const doStrategiesChange = useCallback(
    (name: string, strategies: string[]) => {
      startTransition(async () => {
        addOptimistic({ type: 'strategies', name, strategies });
        await setStrategies(name, strategies);
      });
    },
    [addOptimistic, startTransition],
  );

  const doRiskPercentChange = useCallback(
    (name: string, riskPercent: number | null) => {
      startTransition(async () => {
        addOptimistic({ type: 'riskPercent', name, riskPercent });
        await setRiskPercent(name, riskPercent);
      });
    },
    [addOptimistic, startTransition],
  );

  function doBulkStrategy(strategy: string, enable: boolean) {
    const names = [...active];
    startTransition(async () => {
      addOptimistic({ type: 'bulkStrategy', names, strategy, enable });
      await bulkToggleStrategy(names, strategy, enable);
    });
  }

  // Aggregate strategy state for selected traders
  function getStrategyState(strategy: string): 'all' | 'none' | 'mixed' {
    if (active.size === 0) return 'none';
    const selectedTraders = optimistic.filter((t) => active.has(t.name));
    const count = selectedTraders.filter((t) =>
      t.strategies.includes(strategy),
    ).length;
    if (count === selectedTraders.length) return 'all';
    if (count === 0) return 'none';
    return 'mixed';
  }

  return (
    <div className="space-y-4">
      {/* Header row — transforms into bulk actions when selected */}
      <div className="flex items-center justify-between min-h-[36px]">
        <h2 className="text-lg font-semibold text-foreground">
          Tracked Traders
          <span className="ml-2 text-xs text-muted-foreground font-mono font-normal tabular-nums">
            {optimistic.length}
          </span>
        </h2>
        <div className="flex items-center gap-1.5">
          {active.size > 0 ? (
            <>
              <span className="text-xs text-muted-foreground font-medium mr-1">
                {active.size} sel
              </span>
              {ALL_STRATEGIES.map((s) => {
                const state = getStrategyState(s);
                const isOn = state === 'all';
                const isMixed = state === 'mixed';
                return (
                  <button
                    key={s}
                    onClick={() => doBulkStrategy(s, !isOn)}
                    className={cn(
                      'px-2 py-1 rounded text-[11px] font-mono font-semibold border cursor-pointer transition-all hover:brightness-110 active:scale-95',
                      isOn
                        ? BULK_ON[s]
                        : isMixed
                          ? `${BULK_ON[s]} opacity-50`
                          : 'border-border/50 text-muted-foreground/30',
                    )}
                    title={
                      isOn
                        ? `Disable ${s} for selected`
                        : `Enable ${s} for selected`
                    }
                  >
                    {s}
                  </button>
                );
              })}
              <div className="h-4 w-px bg-border mx-1" />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-destructive"
                onClick={doRemoveSelected}
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Remove
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                onClick={() => setSelected(new Set())}
              >
                <X className="h-3 w-3 mr-1" />
                Clear
              </Button>
            </>
          ) : (
            optimistic.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground/60 hover:text-destructive h-7 text-xs"
                onClick={doRemoveAll}
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Remove all
              </Button>
            )
          )}
        </div>
      </div>

      {/* Add trader bar */}
      <div className="flex gap-2">
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={addOpen}
              className="flex-1 justify-start text-sm font-normal h-9"
            >
              <Search className="h-4 w-4 mr-2 text-muted-foreground" />
              <span className="text-muted-foreground">
                Add trader...
                {available.length > 0 && (
                  <span className="ml-1 font-mono text-xs opacity-60">
                    ({available.length} available)
                  </span>
                )}
              </span>
              <kbd className="ml-auto text-[10px] font-mono text-muted-foreground/40 border border-border/60 rounded px-1.5 py-0.5 leading-none">
                /
              </kbd>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="p-0"
            style={{ width: 'var(--radix-popover-trigger-width)' }}
            align="start"
          >
            <Command>
              <CommandInput placeholder="Search authors..." />
              <CommandList>
                <CommandEmpty className="py-4 text-center text-sm text-muted-foreground">
                  No matching authors.
                </CommandEmpty>
                <CommandGroup>
                  {available.map((name) => (
                    <CommandItem
                      key={name}
                      value={name}
                      onSelect={() => doAdd(name)}
                    >
                      <Plus className="h-4 w-4 text-muted-foreground" />
                      {name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {available.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-9 text-xs whitespace-nowrap"
            onClick={doAddAll}
          >
            <ListPlus className="h-3.5 w-3.5 mr-1.5" />
            Add all ({available.length})
          </Button>
        )}
      </div>

      {/* Table */}
      {optimistic.length === 0 ? (
        <div className="text-sm text-muted-foreground/60 py-12 text-center border border-dashed border-border rounded-lg">
          No traders tracked yet &mdash; search above to add
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px] pl-4">
                  <Checkbox
                    checked={
                      allSelected
                        ? true
                        : someSelected
                          ? 'indeterminate'
                          : false
                    }
                    onCheckedChange={toggleSelectAll}
                  />
                </TableHead>
                <TableHead className="w-[140px]">Name</TableHead>
                <TableHead className="w-[70px]">Active</TableHead>
                <TableHead>Strategies</TableHead>
                <TableHead className="w-[70px]">Risk %</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-[44px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {optimistic.map((trader) => (
                <TraderRow
                  key={trader.name}
                  trader={trader}
                  isSelected={active.has(trader.name)}
                  onSelect={toggleSelect}
                  onToggle={doToggle}
                  onRemove={doRemove}
                  onStrategiesChange={doStrategiesChange}
                  onRiskPercentChange={doRiskPercentChange}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/* ── Memoized table row ─────────────────────────────── */

const TraderRow = memo(function TraderRow({
  trader,
  isSelected,
  onSelect,
  onToggle,
  onRemove,
  onStrategiesChange,
  onRiskPercentChange,
}: {
  trader: TrackedTrader;
  isSelected: boolean;
  onSelect: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => void;
  onRemove: (name: string) => void;
  onStrategiesChange: (name: string, strategies: string[]) => void;
  onRiskPercentChange: (name: string, riskPercent: number | null) => void;
}) {
  const href = useScopedHref();
  const strategies = trader.strategies;

  return (
    <TableRow
      className={cn(
        !trader.enabled && 'opacity-40',
        isSelected && 'bg-primary/5',
      )}
    >
      <TableCell className="pl-4">
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onSelect(trader.name)}
        />
      </TableCell>
      <TableCell className="font-medium">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full shrink-0 transition-colors',
              trader.enabled ? 'bg-profit' : 'bg-muted-foreground/30',
            )}
          />
          <Link
            to={href(`/traders/${encodeURIComponent(trader.name)}`)}
            className="text-foreground hover:underline underline-offset-2 decoration-primary/40"
          >
            {trader.name}
          </Link>
        </div>
      </TableCell>
      <TableCell>
        <Switch
          checked={!!trader.enabled}
          size="sm"
          onCheckedChange={() => onToggle(trader.name, !!trader.enabled)}
        />
      </TableCell>
      <TableCell>
        <ToggleGroup
          type="multiple"
          value={strategies}
          onValueChange={(val) => onStrategiesChange(trader.name, val)}
          variant="outline"
          size="sm"
          spacing={1}
          className="gap-1"
        >
          {ALL_STRATEGIES.map((s) => (
            <ToggleGroupItem
              key={s}
              value={s}
              className={cn(
                '!h-6 !min-w-0 !px-1.5 text-[10px] font-mono font-semibold !shadow-none',
                STRAT_CLASSES[s],
              )}
            >
              {s}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </TableCell>
      <TableCell>
        <RiskPercentCell
          name={trader.name}
          riskPercent={trader.positionSizingConfig?.strategy === 'atr' ? trader.positionSizingConfig.riskPercent : null}
          onChange={onRiskPercentChange}
        />
      </TableCell>
      <TableCell>
        <NotesCell name={trader.name} notes={trader.notes} />
      </TableCell>
      <TableCell>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground/30 hover:text-destructive"
          onClick={() => onRemove(trader.name)}
          title={`Remove ${trader.name}`}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </TableCell>
    </TableRow>
  );
});

/* ── Inline risk % cell ─────────────────────────────── */

const DEFAULT_RISK_PCT = 5.0; // matches buildPositionSizer default of 0.05

function RiskPercentCell({
  name,
  riskPercent,
  onChange,
}: {
  name: string;
  riskPercent: number | null;
  onChange: (name: string, riskPercent: number | null) => void;
}) {
  const displayVal = riskPercent != null ? (riskPercent * 100).toFixed(1) : '';
  const [value, setValue] = useState(displayVal);
  const [, startTransition] = useTransition();

  useEffect(() => {
    setValue(riskPercent != null ? (riskPercent * 100).toFixed(1) : '');
  }, [riskPercent]);

  function save() {
    const trimmed = value.trim();
    if (trimmed === displayVal) return;
    if (trimmed === '') {
      onChange(name, null);
    } else {
      const parsed = parseFloat(trimmed);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
        onChange(name, parsed / 100);
      } else {
        setValue(displayVal); // revert invalid input
      }
    }
  }

  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === 'Escape') {
          setValue(displayVal);
          (e.target as HTMLInputElement).blur();
        }
      }}
      autoComplete="off"
      placeholder={String(DEFAULT_RISK_PCT)}
      className="text-xs bg-transparent text-muted-foreground outline-none w-full max-w-[50px] border-b border-transparent focus:border-ring focus:text-foreground placeholder:text-muted-foreground/40 transition-colors font-mono tabular-nums text-right"
    />
  );
}

/* ── Inline notes cell ───────────────────────────────── */

function NotesCell({
  name,
  notes,
}: {
  name: string;
  notes: string | null;
}) {
  const [value, setValue] = useState(notes ?? '');
  const [, startTransition] = useTransition();

  useEffect(() => {
    setValue(notes ?? '');
  }, [notes]);

  function save() {
    const trimmed = value.trim();
    if (trimmed !== (notes ?? '')) {
      startTransition(() => { setNotes(name, trimmed || null); });
    }
  }

  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === 'Escape') {
          setValue(notes ?? '');
          (e.target as HTMLInputElement).blur();
        }
      }}
      autoComplete="off"
      placeholder="--"
      className="text-xs bg-transparent text-muted-foreground outline-none w-full max-w-48 border-b border-transparent focus:border-ring focus:text-foreground placeholder:text-muted-foreground/40 transition-colors"
    />
  );
}

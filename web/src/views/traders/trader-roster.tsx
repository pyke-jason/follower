import {
  useState,
  useOptimistic,
  useTransition,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search, X, Plus, ListPlus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cva, type VariantProps } from 'class-variance-authority';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { DataTable } from '@/components/data-table';
import type { Column } from '@/lib/api-types';
import type { TrackedTrader } from '@src/db/schema';
import { api } from '@/lib/api';

const TRADERS_KEY = ['traders'] as const;

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
const bulkAdd = (names: string[]) =>
  api('/traders/bulk', { method: 'POST', body: JSON.stringify({ action: 'add', names }) });
const bulkRemove = (names: string[]) =>
  api('/traders/bulk', { method: 'POST', body: JSON.stringify({ action: 'remove', names }) });
const bulkToggleStrategy = (names: string[], strategy: string, enable: boolean) =>
  api('/traders/bulk', { method: 'POST', body: JSON.stringify({ action: 'toggleStrategy', names, strategy, enable }) });

const ALL_STRATEGIES = ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'CCS', 'PCS'] as const;
type Strategy = (typeof ALL_STRATEGIES)[number];

// Strategy-themed toggle item. `data-[state=on]:` selectors match the base
// Toggle cva's specificity — tailwind-merge resolves conflicts in caller order,
// so these override `data-[state=on]:bg-accent` without `!important`.
const strategyToggleVariants = cva(
  'h-6 min-w-0 px-1.5 text-[10px] font-mono font-semibold shadow-none data-[state=off]:text-muted-foreground/25 data-[state=off]:line-through',
  {
    variants: {
      strategy: {
        STOCK: 'data-[state=on]:bg-strategy-stock/15 data-[state=on]:text-strategy-stock-fg',
        CALL: 'data-[state=on]:bg-strategy-call/15 data-[state=on]:text-strategy-call-fg',
        PUT: 'data-[state=on]:bg-strategy-put/15 data-[state=on]:text-strategy-put-fg',
        CDS: 'data-[state=on]:bg-strategy-cds/15 data-[state=on]:text-strategy-cds-fg',
        PDS: 'data-[state=on]:bg-strategy-pds/15 data-[state=on]:text-strategy-pds-fg',
        CCS: 'data-[state=on]:bg-strategy-ccs/15 data-[state=on]:text-strategy-ccs-fg',
        PCS: 'data-[state=on]:bg-strategy-pcs/15 data-[state=on]:text-strategy-pcs-fg',
      },
    },
  },
);

const strategyBulkButtonVariants = cva(
  'px-2 py-1 h-auto rounded text-[11px] font-mono font-semibold transition-all hover:brightness-110 active:scale-95',
  {
    variants: {
      strategy: {
        STOCK: 'bg-strategy-stock/15 text-strategy-stock-fg border-strategy-stock-border',
        CALL: 'bg-strategy-call/15 text-strategy-call-fg border-strategy-call-border',
        PUT: 'bg-strategy-put/15 text-strategy-put-fg border-strategy-put-border',
        CDS: 'bg-strategy-cds/15 text-strategy-cds-fg border-strategy-cds-border',
        PDS: 'bg-strategy-pds/15 text-strategy-pds-fg border-strategy-pds-border',
        CCS: 'bg-strategy-ccs/15 text-strategy-ccs-fg border-strategy-ccs-border',
        PCS: 'bg-strategy-pcs/15 text-strategy-pcs-fg border-strategy-pcs-border',
      },
    },
  },
);

// Local wrapper that binds a Strategy value to the themed variant. Keeps the
// strategy-specific styling at the consumer level without modifying the shadcn
// primitive.
function StrategyToggleItem({
  strategy,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof ToggleGroupItem>, 'value'> &
  VariantProps<typeof strategyToggleVariants> & {
    strategy: Strategy;
  }) {
  return (
    <ToggleGroupItem
      value={strategy}
      className={cn(strategyToggleVariants({ strategy }), className)}
      {...props}
    >
      {children ?? strategy}
    </ToggleGroupItem>
  );
}

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
    };

export function TraderRoster({
  traders,
  authors,
}: {
  traders: TrackedTrader[];
  authors: string[];
}) {
  const qc = useQueryClient();
  const invalidate = useCallback(
    () => qc.invalidateQueries({ queryKey: TRADERS_KEY }),
    [qc],
  );

  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();
  const [removeAllOpen, setRemoveAllOpen] = useState(false);
  const [removeAllConfirm, setRemoveAllConfirm] = useState('');
  const [removeSelectedOpen, setRemoveSelectedOpen] = useState(false);

  const [optimistic, addOptimistic] = useOptimistic(
    traders,
    (state: TrackedTrader[], action: OptAction): TrackedTrader[] => {
      switch (action.type) {
        case 'add': {
          const added: TrackedTrader = {
            name: action.name,
            enabled: true,
            strategies: [...ALL_STRATEGIES],
            notes: null,
            positionSizingConfig: null,
          };
          return [...state, added];
        }
        case 'addAll': {
          const added: TrackedTrader[] = action.names.map((name) => ({
            name,
            enabled: true,
            strategies: [...ALL_STRATEGIES],
            notes: null,
            positionSizingConfig: null,
          }));
          return [...state, ...added];
        }
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
      }
    },
  );

  // / to open search, Escape to clear selection
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = e.target instanceof HTMLElement ? e.target.tagName : null;
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
      try {
        await quickAdd(name);
        toast.success('Trader added');
      } catch {
        toast.error('Failed to add trader');
      } finally {
        invalidate();
      }
    });
  }

  function doAddAll() {
    if (!available.length) return;
    setAddOpen(false);
    startTransition(async () => {
      addOptimistic({ type: 'addAll', names: available });
      try {
        await bulkAdd(available);
        toast.success(`${available.length} traders added`);
      } catch {
        toast.error('Failed to add traders');
      } finally {
        invalidate();
      }
    });
  }

  const doRemove = useCallback(
    (name: string) => {
      startTransition(async () => {
        addOptimistic({ type: 'remove', name });
        try {
          await removeTrader(name);
          toast(`Removed ${name}`, {
            action: {
              label: 'Undo',
              onClick: () => {
                startTransition(async () => {
                  addOptimistic({ type: 'add', name });
                  try {
                    await quickAdd(name);
                  } catch {
                    toast.error('Failed to undo removal');
                  } finally {
                    invalidate();
                  }
                });
              },
            },
          });
        } catch {
          toast.error('Failed to remove trader');
        } finally {
          invalidate();
        }
      });
    },
    [addOptimistic, startTransition, invalidate],
  );

  function doRemoveSelected() {
    const names = [...active];
    if (!names.length) return;
    setRemoveSelectedOpen(false);
    setSelected(new Set());
    startTransition(async () => {
      addOptimistic({ type: 'removeAll', names });
      try {
        await bulkRemove(names);
        toast.success(`${names.length} trader${names.length === 1 ? '' : 's'} removed`);
      } catch {
        toast.error('Failed to remove traders');
      } finally {
        invalidate();
      }
    });
  }

  function doRemoveAll() {
    const names = optimistic.map((t) => t.name);
    if (!names.length) return;
    setRemoveAllOpen(false);
    setRemoveAllConfirm('');
    setSelected(new Set());
    startTransition(async () => {
      addOptimistic({ type: 'removeAll', names });
      try {
        await bulkRemove(names);
        toast.success(`All ${names.length} traders removed`);
      } catch {
        toast.error('Failed to remove traders');
      } finally {
        invalidate();
      }
    });
  }

  const doToggle = useCallback(
    (name: string, enabled: boolean) => {
      startTransition(async () => {
        addOptimistic({ type: 'toggle', name });
        try {
          await toggleEnabled(name, enabled);
        } catch {
          toast.error('Failed to toggle trader');
        } finally {
          invalidate();
        }
      });
    },
    [addOptimistic, startTransition, invalidate],
  );

  const doStrategiesChange = useCallback(
    (name: string, strategies: string[]) => {
      startTransition(async () => {
        addOptimistic({ type: 'strategies', name, strategies });
        try {
          await setStrategies(name, strategies);
        } catch {
          toast.error('Failed to update strategies');
        } finally {
          invalidate();
        }
      });
    },
    [addOptimistic, startTransition, invalidate],
  );

  function doBulkStrategy(strategy: string, enable: boolean) {
    const names = [...active];
    startTransition(async () => {
      addOptimistic({ type: 'bulkStrategy', names, strategy, enable });
      try {
        await bulkToggleStrategy(names, strategy, enable);
      } catch {
        toast.error('Failed to update strategies');
      } finally {
        invalidate();
      }
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

  // Column definitions — defined inside the component to capture callbacks via closure
  const href = useScopedHref();
  const columns = useMemo((): Column<TrackedTrader>[] => [
    {
      key: 'select',
      label: (
        <Checkbox
          checked={allSelected ? true : someSelected ? 'indeterminate' : false}
          onCheckedChange={toggleSelectAll}
        />
      ),
      className: 'w-[40px] pl-4',
      render: (t) => (
        <Checkbox
          checked={active.has(t.name)}
          onCheckedChange={() => toggleSelect(t.name)}
        />
      ),
    },
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      className: 'w-[140px] font-medium',
      render: (t) => (
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full shrink-0 transition-colors',
              t.enabled ? 'bg-profit' : 'bg-muted-foreground/30',
            )}
          />
          <Link
            to={href(`/traders/${encodeURIComponent(t.name)}`)}
            className="text-foreground hover:underline underline-offset-2 decoration-primary/40"
          >
            {t.name}
          </Link>
        </div>
      ),
    },
    {
      key: 'enabled',
      label: 'Active',
      className: 'w-[70px]',
      render: (t) => (
        <Switch
          checked={!!t.enabled}
          size="sm"
          onCheckedChange={() => doToggle(t.name, !!t.enabled)}
        />
      ),
    },
    {
      key: 'strategies',
      label: 'Strategies',
      render: (t) => (
        <ToggleGroup
          type="multiple"
          value={t.strategies}
          onValueChange={(val) => doStrategiesChange(t.name, val)}
          variant="outline"
          size="sm"
          spacing={1}
          className="gap-1"
        >
          {ALL_STRATEGIES.map((s) => (
            <StrategyToggleItem key={s} strategy={s} />
          ))}
        </ToggleGroup>
      ),
    },
    {
      key: 'notes',
      label: 'Notes',
      render: (t) => (
        <NotesCell key={`${t.name}:${t.notes ?? ''}`} name={t.name} notes={t.notes} invalidate={invalidate} />
      ),
    },
    {
      key: 'remove',
      label: '',
      className: 'w-[44px]',
      render: (t) => (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground/30 hover:text-destructive"
          onClick={() => doRemove(t.name)}
          title={`Remove ${t.name}`}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      ),
    },
  ], [active, allSelected, someSelected, toggleSelectAll, toggleSelect, href, doToggle, doStrategiesChange, doRemove, invalidate]);

  const rowClassName = useCallback(
    (t: TrackedTrader) =>
      cn(!t.enabled && 'opacity-40', active.has(t.name) && 'bg-primary/5'),
    [active],
  );

  return (
    <div className="h-full flex flex-col gap-4 pb-2">
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
                  <Button
                    key={s}
                    variant="outline"
                    size="sm"
                    onClick={() => doBulkStrategy(s, !isOn)}
                    className={cn(
                      isOn
                        ? strategyBulkButtonVariants({ strategy: s })
                        : isMixed
                          ? cn(strategyBulkButtonVariants({ strategy: s }), 'opacity-50')
                          : 'px-2 py-1 h-auto rounded text-[11px] font-mono font-semibold transition-all hover:brightness-110 active:scale-95 border-border/50 text-muted-foreground/30',
                    )}
                    title={
                      isOn
                        ? `Disable ${s} for selected`
                        : `Enable ${s} for selected`
                    }
                  >
                    {s}
                  </Button>
                );
              })}
              <div className="h-4 w-px bg-border mx-1" />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => setRemoveSelectedOpen(true)}
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
                onClick={() => setRemoveAllOpen(true)}
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

      {/* Virtualized table */}
      <DataTable
        columns={columns}
        data={optimistic}
        defaultSort={{ column: 'name' }}
        rowClassName={rowClassName}
        className="flex-1 min-h-0"
      />

      {/* Remove all — type-to-confirm AlertDialog */}
      <AlertDialog
        open={removeAllOpen}
        onOpenChange={(open) => {
          setRemoveAllOpen(open);
          if (!open) setRemoveAllConfirm('');
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove all {optimistic.length} traders?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will stop trade copying for all tracked traders. No historical
              data will be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2">
            <label className="text-sm text-muted-foreground">
              Type <span className="font-mono font-semibold text-foreground">REMOVE ALL</span> to confirm
            </label>
            <Input
              value={removeAllConfirm}
              onChange={(e) => setRemoveAllConfirm(e.target.value)}
              placeholder="REMOVE ALL"
              autoComplete="off"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={removeAllConfirm !== 'REMOVE ALL'}
              onClick={doRemoveAll}
            >
              Remove All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove selected — AlertDialog with count */}
      <AlertDialog open={removeSelectedOpen} onOpenChange={setRemoveSelectedOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {active.size} trader{active.size === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will stop trade copying for the selected traders. No
              historical data will be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={doRemoveSelected}>
              Remove {active.size} Trader{active.size === 1 ? '' : 's'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ── Inline notes cell ───────────────────────────────── */

function NotesCell({
  name,
  notes,
  invalidate,
}: {
  name: string;
  notes: string | null;
  invalidate: () => void;
}) {
  const [value, setValue] = useState(notes ?? '');
  const [, startTransition] = useTransition();

  function save() {
    const trimmed = value.trim();
    if (trimmed !== (notes ?? '')) {
      startTransition(async () => {
        try {
          await setNotes(name, trimmed || null);
        } finally {
          invalidate();
        }
      });
    }
  }

  return (
    <Input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          setValue(notes ?? '');
          e.currentTarget.blur();
        }
      }}
      autoComplete="off"
      placeholder="--"
      className="h-auto border-0 border-b border-transparent focus-visible:border-ring focus-visible:ring-0 rounded-none bg-transparent text-xs p-0 text-muted-foreground focus:text-foreground placeholder:text-muted-foreground/40 w-full max-w-48"
    />
  );
}

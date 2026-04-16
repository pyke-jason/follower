import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import type { ColumnMeta, Filter, FilterOp } from '@src/local-api/db-browser-types';

// ── Operator options by column type ─────────────────────────────────────────

const TEXT_OPS: { value: FilterOp; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'like', label: 'like' },
  { value: 'is_null', label: 'is null' },
  { value: 'is_not_null', label: 'is not null' },
];

const NUMERIC_OPS: { value: FilterOp; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'lt', label: '<' },
  { value: 'gte', label: '>=' },
  { value: 'lte', label: '<=' },
  { value: 'is_null', label: 'is null' },
  { value: 'is_not_null', label: 'is not null' },
];

const NO_VALUE_OPS: FilterOp[] = ['is_null', 'is_not_null'];

function getOpsForType(type: string): { value: FilterOp; label: string }[] {
  if (type === 'INTEGER' || type === 'REAL') return NUMERIC_OPS;
  return TEXT_OPS;
}

// ── Single filter row ────────────────────────────────────────────────────────

function FilterRow({
  filter,
  columns,
  onChange,
  onRemove,
}: {
  filter: Filter;
  columns: ColumnMeta[];
  onChange: (f: Filter) => void;
  onRemove: () => void;
}) {
  const meta = columns.find((c) => c.name === filter.column);
  const ops = meta ? getOpsForType(meta.type) : TEXT_OPS;
  const noValue = NO_VALUE_OPS.includes(filter.op);

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs font-medium text-muted-foreground min-w-[80px] truncate" title={filter.column}>
        {filter.column}
      </span>
      <Select
        value={filter.op}
        onValueChange={(op) => onChange({ ...filter, op: op as FilterOp, value: noValue ? undefined : filter.value })}
      >
        <SelectTrigger size="sm" className="w-[110px] text-xs h-7">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op.value} value={op.value} className="text-xs">
              {op.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!noValue && (
        <Input
          className="h-7 text-xs w-[140px]"
          value={filter.value ?? ''}
          onChange={(e) => onChange({ ...filter, value: e.target.value })}
          placeholder="value"
        />
      )}
      <Button
        variant="ghost"
        size="xs"
        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

// ── TableFilters ─────────────────────────────────────────────────────────────

interface TableFiltersProps {
  columns: ColumnMeta[];
  filters: Filter[];
  onChange: (filters: Filter[]) => void;
}

export function TableFilters({ columns, filters, onChange }: TableFiltersProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);

  function addFilter(column: string) {
    const meta = columns.find((c) => c.name === column);
    const defaultOp: FilterOp = 'eq';
    onChange([...filters, { column, op: defaultOp, value: '' }]);
    setPopoverOpen(false);
  }

  function updateFilter(index: number, updated: Filter) {
    const next = [...filters];
    next[index] = updated;
    onChange(next);
  }

  function removeFilter(index: number) {
    onChange(filters.filter((_, i) => i !== index));
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b bg-background/80">
      {filters.map((filter, i) => (
        <FilterRow
          key={i}
          filter={filter}
          columns={columns}
          onChange={(f) => updateFilter(i, f)}
          onRemove={() => removeFilter(i)}
        />
      ))}

      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5">
            <Plus className="size-3.5" />
            Add filter
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-0">
          <Command>
            <CommandInput placeholder="Search columns…" className="text-xs h-8" />
            <CommandList>
              <CommandEmpty className="py-3 text-xs text-center">No columns found</CommandEmpty>
              <CommandGroup>
                {columns.map((col) => (
                  <CommandItem
                    key={col.name}
                    value={col.name}
                    onSelect={addFilter}
                    className="text-xs"
                  >
                    <span className="truncate">{col.name}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">{col.type}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

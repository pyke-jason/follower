import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { Signal } from '@src/agent/schemas';
import type { KeyedSignal, KeyedTrade } from './label-components';

// ── Constants ───────────────────────────────────────────────────────────────

const SIGNAL_ACTIONS = ['OPEN', 'CLOSE', 'ADD', 'TRIM', 'LEG_OFF'] as const satisfies readonly Signal['action'][];
const SIGNAL_DIRECTIONS = ['LONG', 'SHORT'] as const satisfies readonly NonNullable<Signal['direction']>[];
const SIGNAL_STRATEGIES = ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'PCS', 'CCS'] as const satisfies readonly NonNullable<Signal['strategy']>[];
const CLEAR = '---';

// ── Typed ToggleGroup wrappers (no casts) ───────────────────────────────────

function EnumToggleGroup<T extends string>({ value, options, onChange, className }: {
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      onValueChange={(v) => {
        const next = options.find((o) => o === v);
        if (next !== undefined) onChange(next);
      }}
      className={className}
    >
      {options.map((o) => (
        <ToggleGroupItem key={o} value={o} className="text-xs h-6 px-2">
          {o}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function NullableEnumToggleGroup<T extends string, Empty extends null | undefined>({
  value,
  options,
  emptyValue,
  onChange,
  className,
}: {
  value: T | Empty;
  options: readonly T[];
  emptyValue: Empty;
  onChange: (next: T | Empty) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value ?? CLEAR}
      onValueChange={(v) => {
        if (!v) return;
        if (v === CLEAR) {
          onChange(emptyValue);
          return;
        }
        const next = options.find((o) => o === v);
        if (next !== undefined) onChange(next);
      }}
      className={className}
    >
      {options.map((o) => (
        <ToggleGroupItem key={o} value={o} className="text-xs h-6 px-2">
          {o}
        </ToggleGroupItem>
      ))}
      <ToggleGroupItem value={CLEAR} className="text-xs h-6 px-2">
        {CLEAR}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

// ── Signal Editor ───────────────────────────────────────────────────────────

function SignalEditor({ signal, index, total, onChange, onRemove }: {
  signal: KeyedSignal;
  index: number;
  total: number;
  onChange: (s: KeyedSignal) => void;
  onRemove: (() => void) | null;
}) {
  return (
    <div className={cn(index > 0 && 'border-t pt-3 mt-3')}>
      <div className="flex items-center justify-between mb-2">
        {total > 1 && (
          <p className="text-[10px] font-medium text-muted-foreground">Signal {index + 1}</p>
        )}
        {total === 1 && <div />}
        {onRemove && (
          <Button variant="ghost" size="xs" onClick={onRemove} className="text-loss hover:text-loss hover:bg-loss/10 h-5 text-[10px]">
            Remove
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">action</span>
          <EnumToggleGroup
            value={signal.action}
            options={SIGNAL_ACTIONS}
            onChange={(action) => onChange({ ...signal, action })}
            className="flex-wrap justify-start"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">symbol</span>
          <Input
            type="text"
            value={signal.symbol}
            onChange={e => onChange({ ...signal, symbol: e.target.value.toUpperCase() })}
            className="flex-1 h-6 px-1.5 py-0.5 text-xs"
            placeholder="e.g. SPY"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">direction</span>
          <NullableEnumToggleGroup
            value={signal.direction}
            options={SIGNAL_DIRECTIONS}
            emptyValue={null}
            onChange={(direction) => onChange({ ...signal, direction })}
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">strategy</span>
          <NullableEnumToggleGroup
            value={signal.strategy}
            options={SIGNAL_STRATEGIES}
            emptyValue={null}
            onChange={(strategy) => onChange({ ...signal, strategy })}
            className="flex-wrap justify-start"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">strikes</span>
          <Input
            type="text"
            value={signal.strikes?.join(', ') ?? ''}
            onChange={e => {
              const val = e.target.value;
              if (!val.trim()) { onChange({ ...signal, strikes: null }); return; }
              const nums = val.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
              onChange({ ...signal, strikes: nums.length > 0 ? nums : null });
            }}
            className="flex-1 h-6 px-1.5 py-0.5 text-xs"
            placeholder="e.g. 450, 460"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">expiry</span>
          <Input
            type="text"
            value={signal.expiry ?? ''}
            onChange={e => onChange({ ...signal, expiry: e.target.value || null })}
            className="flex-1 h-6 px-1.5 py-0.5 text-xs"
            placeholder="e.g. 5/23 or Oct (17)"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">price</span>
          <Input
            type="number"
            step="0.01"
            value={signal.statedPrice ?? ''}
            onChange={e => onChange({ ...signal, statedPrice: e.target.value ? parseFloat(e.target.value) : null })}
            className="flex-1 h-6 px-1.5 py-0.5 text-xs"
            placeholder="e.g. 2.50"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">qty</span>
          <Input
            type="number"
            step="1"
            value={signal.quantity ?? ''}
            onChange={e => onChange({ ...signal, quantity: e.target.value ? parseInt(e.target.value, 10) : null })}
            className="flex-1 h-6 px-1.5 py-0.5 text-xs"
            placeholder="e.g. 10"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">exit%</span>
          <Input
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={signal.exitPercent ?? ''}
            onChange={e => onChange({ ...signal, exitPercent: e.target.value ? parseFloat(e.target.value) : undefined })}
            className="flex-1 h-6 px-1.5 py-0.5 text-xs"
            placeholder="e.g. 0.5"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">target</span>
          <NullableEnumToggleGroup
            value={signal.targetStrategy}
            options={SIGNAL_STRATEGIES}
            emptyValue={undefined}
            onChange={(targetStrategy) => onChange({ ...signal, targetStrategy })}
            className="flex-wrap justify-start"
          />
        </div>
      </div>
    </div>
  );
}

// ── Trade Editor ────────────────────────────────────────────────────────────

export function TradeEditor({ trade, index, total, onChange, onRemove, addSignal }: {
  trade: KeyedTrade;
  index: number;
  total: number;
  onChange: (trade: KeyedTrade) => void;
  onRemove: (() => void) | null;
  addSignal: () => void;
}) {
  const signals = trade.signals;

  const updateSignal = (signalIndex: number, updated: KeyedSignal) => {
    const nextSignals = [...signals];
    nextSignals[signalIndex] = updated;
    onChange({ ...trade, signals: nextSignals });
  };

  const removeSignal = (signalIndex: number) => {
    onChange({ ...trade, signals: signals.filter((_, i) => i !== signalIndex) });
  };

  return (
    <div className={cn('rounded-md border px-3 py-2.5', index > 0 && 'mt-3')}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {total > 1 ? `Trade ${index + 1}` : 'Trade'}
        </p>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="xs" onClick={addSignal} className="text-xs">
            + Add Signal
          </Button>
          {onRemove && (
            <Button variant="ghost" size="xs" onClick={onRemove} className="text-loss hover:text-loss hover:bg-loss/10">
              Remove Trade
            </Button>
          )}
        </div>
      </div>

      {signals.map((signal, signalIndex) => (
        <SignalEditor
          key={signal._id}
          signal={signal}
          index={signalIndex}
          total={signals.length}
          onChange={(updated) => updateSignal(signalIndex, updated)}
          onRemove={signals.length > 1 ? () => removeSignal(signalIndex) : null}
        />
      ))}
    </div>
  );
}

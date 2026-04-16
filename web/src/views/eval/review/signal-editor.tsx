import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { Signal } from '@src/agent/schemas';
import type { KeyedSignal, KeyedTrade } from './label-components';

// ── Constants ───────────────────────────────────────────────────────────────

const SIGNAL_ACTIONS: Signal['action'][] = ['OPEN', 'CLOSE', 'ADD', 'TRIM', 'LEG_OFF'];
const SIGNAL_STRATEGIES = ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'PCS', 'CCS'] as const;

// ── Signal Editor ───────────────────────────────────────────────────────────

function SignalEditor({ signal, index, total, onChange, onRemove }: {
  signal: KeyedSignal;
  index: number;
  total: number;
  onChange: (s: KeyedSignal) => void;
  onRemove: (() => void) | null;
}) {
  const update = <K extends keyof Signal>(key: K, value: Signal[K]) => {
    onChange({ ...signal, [key]: value } as KeyedSignal);
  };

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
          <ToggleGroup type="single" variant="outline" size="sm"
            value={signal.action}
            onValueChange={v => { if (v) update('action', v as Signal['action']); }}
            className="flex-wrap justify-start"
          >
            {SIGNAL_ACTIONS.map((action) => (
              <ToggleGroupItem key={action} value={action} className="text-xs h-6 px-2">
                {action}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">symbol</span>
          <Input
            type="text"
            value={signal.symbol}
            onChange={e => update('symbol', e.target.value.toUpperCase())}
            className="flex-1 h-6 px-1.5 py-0.5 text-xs"
            placeholder="e.g. SPY"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">direction</span>
          <ToggleGroup type="single" variant="outline" size="sm"
            value={signal.direction ?? '---'}
            onValueChange={v => { if (v) update('direction', v === '---' ? null : v as Signal['direction']); }}
            className=""
          >
            <ToggleGroupItem value="LONG" className="text-xs h-6 px-2">LONG</ToggleGroupItem>
            <ToggleGroupItem value="SHORT" className="text-xs h-6 px-2">SHORT</ToggleGroupItem>
            <ToggleGroupItem value="---" className="text-xs h-6 px-2">---</ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">strategy</span>
          <ToggleGroup type="single" variant="outline" size="sm"
            value={signal.strategy ?? '---'}
            onValueChange={v => { if (v) update('strategy', v === '---' ? null : v as Signal['strategy']); }}
            className="flex-wrap justify-start"
          >
            {SIGNAL_STRATEGIES.map((strategy) => (
              <ToggleGroupItem key={strategy} value={strategy} className="text-xs h-6 px-2">
                {strategy}
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value="---" className="text-xs h-6 px-2">---</ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">strikes</span>
          <Input
            type="text"
            value={signal.strikes?.join(', ') ?? ''}
            onChange={e => {
              const val = e.target.value;
              if (!val.trim()) { update('strikes', null); return; }
              const nums = val.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
              update('strikes', nums.length > 0 ? nums : null);
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
            onChange={e => update('expiry', e.target.value || null)}
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
            onChange={e => update('statedPrice', e.target.value ? parseFloat(e.target.value) : null)}
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
            onChange={e => update('quantity', e.target.value ? parseInt(e.target.value, 10) : null)}
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
            onChange={e => update('exitPercent', e.target.value ? parseFloat(e.target.value) : undefined)}
            className="flex-1 h-6 px-1.5 py-0.5 text-xs"
            placeholder="e.g. 0.5"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">target</span>
          <ToggleGroup type="single" variant="outline" size="sm"
            value={signal.targetStrategy ?? '---'}
            onValueChange={v => { if (v) update('targetStrategy', v === '---' ? undefined : v as Signal['targetStrategy']); }}
            className="flex-wrap justify-start"
          >
            {SIGNAL_STRATEGIES.map((strategy) => (
              <ToggleGroupItem key={strategy} value={strategy} className="text-xs h-6 px-2">
                {strategy}
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value="---" className="text-xs h-6 px-2">---</ToggleGroupItem>
          </ToggleGroup>
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

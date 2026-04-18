import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { Signal } from '@src/agent/schemas';
import type { EvalLabel } from './types';
import { TradeEditor } from './signal-editor';

// ── Keyed types (stable React keys for editor arrays) ───────────────────────

export type KeyedSignal = Signal & { _id: string };
export type KeyedTrade = { _id: string; signals: KeyedSignal[] };
export type EditLabel = Omit<EvalLabel, 'trades'> & { trades: KeyedTrade[] };

let _editorIdCounter = 0;
function nextEditorId(prefix: 'sig' | 'trade'): string {
  return `${prefix}-${++_editorIdCounter}`;
}

export function keySignal(s: Signal): KeyedSignal {
  return { ...s, _id: nextEditorId('sig') };
}

export function keyTrades(trades: Signal[][]): KeyedTrade[] {
  return trades.map((signals) => ({
    _id: nextEditorId('trade'),
    signals: signals.map(keySignal),
  }));
}

export function stripTrades(trades: KeyedTrade[]): Signal[][] {
  return trades.map((trade) => trade.signals.map(({ _id: _, ...rest }) => rest));
}

function emptySignal(): KeyedSignal {
  return {
    _id: nextEditorId('sig'),
    action: 'OPEN',
    symbol: '',
    direction: null,
    strategy: null,
    strikes: null,
    expiry: null,
    statedPrice: null,
    quantity: null,
  };
}

function emptyTrade(): KeyedTrade {
  return { _id: nextEditorId('trade'), signals: [emptySignal()] };
}

// ── Small display helpers ───────────────────────────────────────────────────

function ConfidenceDot({ confidence, showLabel }: { confidence: string; showLabel?: boolean }) {
  const isLow = confidence === 'LOW';
  return (
    <span className={cn(
      'inline-flex items-center gap-1 text-[10px] font-medium',
      isLow ? 'text-warning' : 'text-muted-foreground',
    )}>
      <span className={cn('w-1.5 h-1.5 rounded-full', isLow ? 'bg-warning' : 'bg-muted-foreground/40')} />
      {showLabel && confidence}
    </span>
  );
}

function LabelField({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <span className="text-sm">
      <span className="text-muted-foreground text-[10px] mr-0.5">{label}</span>{' '}
      <span className={cn('font-medium', highlight && 'text-profit')}>{value}</span>
    </span>
  );
}

export function ActionButton({ label, kbd, onClick, disabled, variant }: {
  label: string; kbd: string; onClick: () => void; disabled: boolean;
  variant: 'positive' | 'caution' | 'negative' | 'neutral';
}) {
  const styles = {
    positive: 'hover:bg-profit/10 hover:text-profit',
    caution: 'hover:bg-warning/10 hover:text-warning',
    negative: 'hover:bg-loss/10 hover:text-loss',
    neutral: 'hover:bg-muted',
  };
  return (
    <Button variant="outline" size="xs" onClick={onClick} disabled={disabled}
      className={cn(styles[variant])}>
      <Kbd>{kbd}</Kbd>
      <span>{label}</span>
    </Button>
  );
}

// ── Signal Display ──────────────────────────────────────────────────────────

function SignalDisplay({ signal, index, total }: { signal: Signal; index: number; total: number }) {
  return (
    <div className={cn(total > 1 && 'pt-2', index > 0 && 'border-t mt-2')}>
      {total > 1 && (
        <p className="text-[10px] font-medium text-muted-foreground mb-1.5">Signal {index + 1}</p>
      )}
      <div className="flex items-center gap-3 mb-1">
        <LabelField label="action" value={signal.action} />
        {signal.direction && <LabelField label="dir" value={signal.direction} />}
        {signal.symbol && <LabelField label="sym" value={signal.symbol} />}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {signal.strategy && <LabelField label="strategy" value={signal.strategy} />}
        {signal.strikes && signal.strikes.length > 0 && <LabelField label="strikes" value={signal.strikes.join(', ')} />}
        {signal.expiry && <LabelField label="exp" value={signal.expiry} />}
        {signal.statedPrice != null && <LabelField label="price" value={String(signal.statedPrice)} />}
        {signal.quantity != null && <LabelField label="qty" value={String(signal.quantity)} />}
        {signal.exitPercent != null && <LabelField label="exit%" value={`${Math.round(signal.exitPercent * 100)}%`} />}
        {signal.targetStrategy && <LabelField label="target" value={signal.targetStrategy} />}
      </div>
    </div>
  );
}

// ── Label Display ───────────────────────────────────────────────────────────

export function LabelDisplay({ label, title }: { label: EvalLabel; title: string }) {
  const trades = label.trades ?? [];
  const totalSignals = trades.reduce((sum, trade) => sum + trade.length, 0);
  return (
    <div className="rounded-md border px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">{title}</p>
      <div className="flex items-center gap-3 mb-2">
        <LabelField label="isTrade" value={label.isTrade ? 'YES' : 'NO'} highlight={label.isTrade} />
        {trades.length > 1 && (
          <span className="text-xs bg-info/10 text-info px-1.5 py-0.5 rounded font-medium">
            {trades.length} trades
          </span>
        )}
        {trades.length === 1 && totalSignals > 1 && (
          <span className="text-xs bg-info/10 text-info px-1.5 py-0.5 rounded font-medium">
            {totalSignals} signals
          </span>
        )}
        <span className="ml-auto">
          <ConfidenceDot confidence={label.confidence} showLabel />
        </span>
      </div>
      {label.isTrade && trades.length > 0 && (
        <div className="mb-2 space-y-3">
          {trades.map((legs, ti) => (
            <div key={ti} className={cn(trades.length > 1 && 'border rounded-md px-2.5 py-2')}>
              {trades.length > 1 && (
                <p className="text-[10px] font-medium text-muted-foreground mb-1.5">Trade {ti + 1}</p>
              )}
              {legs.map((signal, li) => (
                <SignalDisplay key={li} signal={signal} index={li} total={legs.length} />
              ))}
            </div>
          ))}
        </div>
      )}
      {label.reasoning && (
        <p className="text-xs text-muted-foreground leading-relaxed mt-1">{label.reasoning}</p>
      )}
    </div>
  );
}

// ── Label Editor ────────────────────────────────────────────────────────────

export function LabelEditor({ label, onChange }: { label: EditLabel; onChange: (l: EditLabel) => void }) {
  const trades = label.trades ?? [];

  const updateTrade = (index: number, updated: KeyedTrade) => {
    const nextTrades = [...trades];
    nextTrades[index] = updated;
    onChange({ ...label, trades: nextTrades });
  };

  const removeTrade = (index: number) => {
    onChange({ ...label, trades: trades.filter((_, i) => i !== index) });
  };

  const addTrade = () => {
    onChange({ ...label, trades: [...trades, emptyTrade()] });
  };

  const addSignalToTrade = (tradeIndex: number) => {
    const trade = trades[tradeIndex];
    updateTrade(tradeIndex, { ...trade, signals: [...trade.signals, emptySignal()] });
  };

  const toggleIsTrade = (value: boolean) => {
    if (value) {
      const nextTrades = trades.length === 0 ? [emptyTrade()] : trades;
      onChange({ ...label, isTrade: true, trades: nextTrades });
    } else {
      onChange({ ...label, isTrade: false, trades: [] });
    }
  };

  return (
    <div className="rounded-md border border-warning/40 px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-warning mb-2">Edit Label</p>
      <div className="space-y-3">
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-16">isTrade</span>
            <ToggleGroup type="single" variant="outline" size="sm"
              value={label.isTrade ? 'YES' : 'NO'}
              onValueChange={v => { if (v) toggleIsTrade(v === 'YES'); }}
              className="h-6"
            >
              <ToggleGroupItem value="YES" className="text-xs h-6 px-2">YES</ToggleGroupItem>
              <ToggleGroupItem value="NO" className="text-xs h-6 px-2">NO</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">confidence</span>
            <ToggleGroup type="single" variant="outline" size="sm"
              value={label.confidence}
              onValueChange={v => { if (v) onChange({ ...label, confidence: v as 'HIGH' | 'LOW' }); }}
              className="h-6"
            >
              <ToggleGroupItem value="HIGH" className="text-xs h-6 px-2">HIGH</ToggleGroupItem>
              <ToggleGroupItem value="LOW" className="text-xs h-6 px-2">LOW</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
        {label.isTrade && (
          <div>
            {trades.map((trade, index) => (
              <TradeEditor
                key={trade._id}
                trade={trade}
                index={index}
                total={trades.length}
                onChange={(updated) => updateTrade(index, updated)}
                onRemove={trades.length > 1 ? () => removeTrade(index) : null}
                addSignal={() => addSignalToTrade(index)}
              />
            ))}
            <div className="mt-3">
              <Button variant="outline" size="xs" onClick={addTrade} className="text-xs">
                + Add Trade
              </Button>
            </div>
          </div>
        )}
        {label.reasoning && (
          <p className="text-xs text-muted-foreground leading-relaxed italic">{label.reasoning}</p>
        )}
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { saveIntentLabel, type MessageIntent } from './actions';
import type { Signal, MessageLabel } from '../../../src/db/schema';

const NONE = '__none__';

/** Derive initial form values from an existing label or from intent signals. */
function getDefaults(intent: MessageIntent, label?: MessageLabel) {
  const signals = (intent.signals ?? []) as Signal[];
  const signal = signals[0];

  // If a label already exists, use its values. Otherwise pre-fill from the intent.
  if (label) {
    return {
      isTrade: label.isTrade ?? false,
      action: label.action ?? NONE,
      direction: label.direction ?? NONE,
      strategy: label.strategy ?? NONE,
      symbol: label.symbol ?? '',
      price: label.price ?? '',
      strikes: label.strikes?.join(', ') ?? '',
      expiry: label.expiry ?? '',
      quantity: label.quantity ?? '',
      exitPercent: label.exitPercent != null ? String(label.exitPercent) : '',
      notes: label.notes ?? '',
    };
  }

  const isTrade = intent.decision === 'EXECUTE' && signals.length > 0;
  return {
    isTrade,
    action: signal?.action ?? NONE,
    direction: signal?.direction ?? NONE,
    strategy: signal?.strategy ?? NONE,
    symbol: signal?.symbol ?? '',
    price: signal?.limitPrice ?? '',
    strikes: signal?.legs?.map((l) => l.strike).join(', ') ?? '',
    expiry: signal?.legs?.[0]?.expiry ?? '',
    quantity: '',
    exitPercent: signal?.exitPercent != null ? String(signal.exitPercent) : '',
    notes: '',
  };
}

export function LabelEditSheet({
  messageId,
  intent,
  label,
  open,
  onOpenChange,
}: {
  messageId: string;
  intent: MessageIntent;
  label?: MessageLabel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const defaults = getDefaults(intent, label);
  const [isTrade, setIsTrade] = useState(defaults.isTrade);
  const [action, setAction] = useState(defaults.action);
  const [direction, setDirection] = useState(defaults.direction);
  const [strategy, setStrategy] = useState(defaults.strategy);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[500px] p-0 flex flex-col">
        <SheetHeader className="px-4 py-3 border-b shrink-0">
          <SheetTitle className="text-sm font-medium">Edit Label</SheetTitle>
          <p className="text-xs text-muted-foreground">
            {label ? 'Editing existing label' : 'Creating label from intent'}
          </p>
        </SheetHeader>

        <form
          action={async (formData: FormData) => {
            await saveIntentLabel(messageId, formData);
            onOpenChange(false);
          }}
          className="flex flex-col flex-1 min-h-0"
        >
          <input type="hidden" name="isTrade" value={String(isTrade)} />
          <input type="hidden" name="action" value={action === NONE ? '' : action} />
          <input type="hidden" name="direction" value={direction === NONE ? '' : direction} />
          <input type="hidden" name="strategy" value={strategy === NONE ? '' : strategy} />

          <ScrollArea className="flex-1">
            <div className="p-4 space-y-4">
              {/* Intent comparison */}
              <IntentComparisonGrid intent={intent} />

              {/* Classification */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Classification
                </h4>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Is Trade</Label>
                    <div className="flex items-center gap-2">
                      <Switch checked={isTrade} onCheckedChange={setIsTrade} />
                      <span className="text-xs">{isTrade ? 'Yes' : 'No'}</span>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Action</Label>
                    <Select value={action} onValueChange={setAction}>
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>None</SelectItem>
                        <SelectItem value="OPEN">OPEN</SelectItem>
                        <SelectItem value="CLOSE">CLOSE</SelectItem>
                        <SelectItem value="ADD">ADD</SelectItem>
                        <SelectItem value="TRIM">TRIM</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Direction</Label>
                    <Select value={direction} onValueChange={setDirection}>
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>None</SelectItem>
                        <SelectItem value="LONG">LONG</SelectItem>
                        <SelectItem value="SHORT">SHORT</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Strategy</Label>
                    <Select value={strategy} onValueChange={setStrategy}>
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>None</SelectItem>
                        <SelectItem value="STOCK">STOCK</SelectItem>
                        <SelectItem value="CALL">CALL</SelectItem>
                        <SelectItem value="PUT">PUT</SelectItem>
                        <SelectItem value="CDS">CDS</SelectItem>
                        <SelectItem value="PDS">PDS</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* Trade Details */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Trade Details
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Symbol</Label>
                    <Input
                      name="symbol"
                      defaultValue={defaults.symbol}
                      className="h-8 text-sm"
                      placeholder="AAPL"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Price</Label>
                    <Input
                      name="price"
                      defaultValue={defaults.price}
                      className="h-8 text-sm"
                      placeholder="12.50"
                    />
                  </div>
                  {action === 'TRIM' && (
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Exit %</Label>
                      <Input
                        name="exitPercent"
                        type="number"
                        step="0.1"
                        min="0"
                        max="1"
                        defaultValue={defaults.exitPercent}
                        className="h-8 text-sm"
                        placeholder="0.5"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Options */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Options
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Strikes</Label>
                    <Input
                      name="strikes"
                      defaultValue={defaults.strikes}
                      className="h-8 text-sm"
                      placeholder="100, 110"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Expiry</Label>
                    <Input
                      name="expiry"
                      type="date"
                      defaultValue={defaults.expiry}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Quantity</Label>
                    <Input
                      name="quantity"
                      defaultValue={defaults.quantity}
                      className="h-8 text-sm"
                      placeholder="5"
                    />
                  </div>
                </div>
              </div>

              {/* Notes */}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Notes</Label>
                <Input
                  name="notes"
                  defaultValue={defaults.notes}
                  className="h-8 text-sm"
                  placeholder="Optional notes..."
                />
              </div>
            </div>
          </ScrollArea>

          {/* Footer */}
          <div className="border-t px-4 py-3 flex items-center gap-2 shrink-0">
            <div className="flex-1" />
            <Button variant="ghost" size="sm" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" type="submit">
              Save & Mark Reviewed
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** Shows what the intent extracted, for reference while editing. */
function IntentComparisonGrid({ intent }: { intent: MessageIntent }) {
  const signals = (intent.signals ?? []) as Signal[];
  const signal = signals[0];

  if (!signal && intent.decision === 'SKIP') {
    return (
      <div className="rounded-md border p-3 text-xs text-muted-foreground">
        Intent: SKIP — {intent.reasoning?.slice(0, 120) ?? 'no reasoning'}
      </div>
    );
  }

  if (!signal) return null;

  const rows: [string, string][] = [
    ['Decision', intent.decision],
    ['Action', signal.action],
    ['Direction', signal.direction],
    ['Strategy', signal.strategy],
    ['Symbol', signal.symbol],
  ];
  if (signal.limitPrice) rows.push(['Price', signal.limitPrice]);
  if (signal.legs?.length) {
    rows.push(['Strikes', signal.legs.map((l) => l.strike).join(', ')]);
    rows.push(['Expiry', signal.legs[0].expiry]);
  }
  if (signal.exitPercent != null) rows.push(['Exit %', String(signal.exitPercent)]);

  return (
    <div className="rounded-md border p-3 space-y-0">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide pb-1 border-b mb-1">
        Intent extraction
      </div>
      {rows.map(([field, value]) => (
        <div key={field} className="grid grid-cols-[100px_1fr] gap-2 text-xs py-0.5">
          <span className="text-muted-foreground">{field}</span>
          <span className="font-mono">{value}</span>
        </div>
      ))}
    </div>
  );
}

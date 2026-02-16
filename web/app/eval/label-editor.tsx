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
import { saveLabel, approveLabel, deleteLabel } from './actions';

export type LabelData = {
  id: string;
  isTrade: boolean | null;
  action: string | null;
  direction: string | null;
  strategy: string | null;
  symbol: string | null;
  price: string | null;
  strikes: number[] | null;
  quantity: string | null;
  expiry: string | null;
  exitPercent: number | null;
  notes: string | null;
  reviewed: boolean | null;
};

export type ParseHints = {
  actionHint: string | null;
  directionHint: string | null;
  strategy: string | null;
  price: number | null;
  strikes: number[] | null;
  expiry: string | null;
  symbol: string | null;
};

type MessageInfo = {
  author: string;
  timestamp: string;
  cleanText: string;
};

const NONE = '__none__';

// --- LabelActions: inline buttons shown in table ---

export function LabelActions({
  label,
  message,
  parseHints,
}: {
  label: LabelData;
  message: MessageInfo;
  parseHints: ParseHints;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="flex gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs px-2"
          onClick={() => setOpen(true)}
        >
          Edit
        </Button>
        {!label.reviewed && (
          <form action={approveLabel}>
            <input type="hidden" name="id" value={label.id} />
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs px-2 text-profit"
              type="submit"
            >
              Ok
            </Button>
          </form>
        )}
      </div>
      <LabelEditSheet
        label={label}
        message={message}
        parseHints={parseHints}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

// --- ComparisonGrid: side-by-side parse vs label ---

function ComparisonRow({
  field,
  parseValue,
  labelValue,
}: {
  field: string;
  parseValue: string | null;
  labelValue: string | null;
}) {
  const pv = parseValue ?? '–';
  const lv = labelValue ?? '–';
  const mismatch = parseValue != null && labelValue != null && parseValue !== labelValue;
  return (
    <div className="grid grid-cols-[100px_1fr_1fr] gap-2 text-xs py-1">
      <span className="text-muted-foreground">{field}</span>
      <span className="font-mono">{pv}</span>
      <span className={`font-mono ${mismatch ? 'text-warning font-medium' : ''}`}>
        {lv}
      </span>
    </div>
  );
}

function ComparisonGrid({
  parseHints,
  label,
}: {
  parseHints: ParseHints;
  label: LabelData;
}) {
  return (
    <div className="rounded-md border p-3 space-y-0">
      <div className="grid grid-cols-[100px_1fr_1fr] gap-2 text-[10px] text-muted-foreground uppercase tracking-wide pb-1 border-b mb-1">
        <span>Field</span>
        <span>Parse</span>
        <span>Label</span>
      </div>
      <ComparisonRow field="Action" parseValue={parseHints.actionHint} labelValue={label.action} />
      <ComparisonRow field="Direction" parseValue={parseHints.directionHint} labelValue={label.direction} />
      <ComparisonRow field="Strategy" parseValue={parseHints.strategy} labelValue={label.strategy} />
      <ComparisonRow field="Symbol" parseValue={parseHints.symbol} labelValue={label.symbol} />
      <ComparisonRow
        field="Price"
        parseValue={parseHints.price != null ? String(parseHints.price) : null}
        labelValue={label.price}
      />
      <ComparisonRow
        field="Strikes"
        parseValue={parseHints.strikes?.join(', ') ?? null}
        labelValue={label.strikes?.join(', ') ?? null}
      />
      <ComparisonRow field="Expiry" parseValue={parseHints.expiry} labelValue={label.expiry} />
    </div>
  );
}

// --- LabelEditSheet: the Sheet-based editor ---

function LabelEditSheet({
  label,
  message,
  parseHints,
  open,
  onOpenChange,
}: {
  label: LabelData;
  message: MessageInfo;
  parseHints: ParseHints;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [isTrade, setIsTrade] = useState(label.isTrade ?? false);
  const [action, setAction] = useState(label.action ?? NONE);
  const [direction, setDirection] = useState(label.direction ?? NONE);
  const [strategy, setStrategy] = useState(label.strategy ?? NONE);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[500px] p-0 flex flex-col">
        <SheetHeader className="px-4 py-3 border-b shrink-0">
          <SheetTitle className="text-sm font-medium">Edit Label</SheetTitle>
          <p className="text-xs text-muted-foreground">
            {message.author} &middot; {new Date(message.timestamp).toLocaleDateString()}
          </p>
        </SheetHeader>

        <form
          action={async (formData: FormData) => {
            await saveLabel(formData);
            onOpenChange(false);
          }}
          className="flex flex-col flex-1 min-h-0"
        >
          <input type="hidden" name="id" value={label.id} />
          <input type="hidden" name="isTrade" value={String(isTrade)} />
          <input type="hidden" name="action" value={action === NONE ? '' : action} />
          <input type="hidden" name="direction" value={direction === NONE ? '' : direction} />
          <input type="hidden" name="strategy" value={strategy === NONE ? '' : strategy} />

          <ScrollArea className="flex-1">
            <div className="p-4 space-y-4">
              {/* Message text */}
              <div className="rounded-md bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                  {message.cleanText}
                </p>
              </div>

              {/* Comparison grid */}
              <ComparisonGrid parseHints={parseHints} label={label} />

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
                      defaultValue={label.symbol ?? ''}
                      className="h-8 text-sm"
                      placeholder="AAPL"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Price</Label>
                    <Input
                      name="price"
                      defaultValue={label.price ?? ''}
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
                        defaultValue={label.exitPercent ?? ''}
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
                      defaultValue={label.strikes?.join(', ') ?? ''}
                      className="h-8 text-sm"
                      placeholder="100, 110"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Expiry</Label>
                    <Input
                      name="expiry"
                      type="date"
                      defaultValue={label.expiry ?? ''}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Quantity</Label>
                    <Input
                      name="quantity"
                      defaultValue={label.quantity ?? ''}
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
                  defaultValue={label.notes ?? ''}
                  className="h-8 text-sm"
                  placeholder="Optional notes..."
                />
              </div>
            </div>
          </ScrollArea>

          {/* Footer */}
          <div className="border-t px-4 py-3 flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              type="button"
              onClick={async () => {
                const fd = new FormData();
                fd.set('id', label.id);
                await deleteLabel(fd);
                onOpenChange(false);
              }}
            >
              Delete
            </Button>
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

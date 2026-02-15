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
import { saveLabel, approveLabel, deleteLabel } from './actions';

type LabelData = {
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
  notes: string | null;
  reviewed: boolean | null;
};

const NONE = '__none__';

export function LabelEditor({ label }: { label: LabelData }) {
  const [open, setOpen] = useState(false);
  const [isTrade, setIsTrade] = useState(label.isTrade ?? false);
  const [action, setAction] = useState(label.action ?? NONE);
  const [direction, setDirection] = useState(label.direction ?? NONE);
  const [strategy, setStrategy] = useState(label.strategy ?? NONE);

  if (!open) {
    return (
      <div className="flex gap-1">
        <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => setOpen(true)}>
          Edit
        </Button>
        {!label.reviewed && (
          <form action={approveLabel}>
            <input type="hidden" name="id" value={label.id} />
            <Button variant="ghost" size="sm" className="h-6 text-xs px-2 text-green-600" type="submit">
              Ok
            </Button>
          </form>
        )}
      </div>
    );
  }

  return (
    <div className="col-span-full bg-muted/50 border rounded-lg p-4 space-y-3">
      <form action={saveLabel} className="space-y-3">
        <input type="hidden" name="id" value={label.id} />
        <input type="hidden" name="isTrade" value={String(isTrade)} />
        <input type="hidden" name="action" value={action === NONE ? '' : action} />
        <input type="hidden" name="direction" value={direction === NONE ? '' : direction} />
        <input type="hidden" name="strategy" value={strategy === NONE ? '' : strategy} />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {/* isTrade */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Is Trade</Label>
            <div className="flex items-center gap-2">
              <Switch checked={isTrade} onCheckedChange={setIsTrade} />
              <span className="text-xs">{isTrade ? 'Yes' : 'No'}</span>
            </div>
          </div>

          {/* Action */}
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
              </SelectContent>
            </Select>
          </div>

          {/* Direction */}
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

          {/* Strategy */}
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

          {/* Symbol */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Symbol</Label>
            <Input name="symbol" defaultValue={label.symbol ?? ''} className="h-8 text-sm" placeholder="AAPL" />
          </div>

          {/* Price */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Price</Label>
            <Input name="price" defaultValue={label.price ?? ''} className="h-8 text-sm" placeholder="12.50" />
          </div>

          {/* Strikes */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Strikes</Label>
            <Input
              name="strikes"
              defaultValue={label.strikes?.join(', ') ?? ''}
              className="h-8 text-sm"
              placeholder="100, 110"
            />
          </div>

          {/* Quantity */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Quantity</Label>
            <Input name="quantity" defaultValue={label.quantity ?? ''} className="h-8 text-sm" placeholder="5" />
          </div>

          {/* Expiry */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Expiry</Label>
            <Input name="expiry" type="date" defaultValue={label.expiry ?? ''} className="h-8 text-sm" />
          </div>

          {/* Notes */}
          <div className="space-y-1 col-span-2 sm:col-span-3">
            <Label className="text-xs text-muted-foreground">Notes</Label>
            <Input name="notes" defaultValue={label.notes ?? ''} className="h-8 text-sm" placeholder="Optional notes..." />
          </div>
        </div>

        <div className="flex gap-2 justify-end">
          <form action={deleteLabel}>
            <input type="hidden" name="id" value={label.id} />
            <Button variant="ghost" size="sm" className="text-red-600" type="submit">
              Delete
            </Button>
          </form>
          <Button variant="ghost" size="sm" type="button" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" type="submit">
            Save & Mark Reviewed
          </Button>
        </div>
      </form>
    </div>
  );
}

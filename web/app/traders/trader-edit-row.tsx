'use client';

import { useState } from 'react';
import type { TrackedTrader } from '../../../src/db/schema';
import { updateTrader, deleteTrader, toggleTrader } from './actions';
import { TableRow, TableCell } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

export function TraderEditRow({ trader }: { trader: TrackedTrader }) {
  const [editing, setEditing] = useState(false);
  const strategies = (trader.strategies as string[]) || [];

  if (editing) {
    return (
      <TableRow className="bg-muted/30">
        <TableCell className="px-4 font-medium text-foreground">{trader.name}</TableCell>
        <TableCell className="px-4" colSpan={5}>
          <form
            action={async (fd) => {
              fd.set('name', trader.name);
              await updateTrader(fd);
              setEditing(false);
            }}
            className="flex items-end gap-2 flex-wrap"
          >
            <input type="hidden" name="name" value={trader.name} />
            <div>
              <Label className="text-xs text-muted-foreground mb-1">Strategies</Label>
              <Input
                name="strategies"
                defaultValue={strategies.join(',')}
                className="h-7 text-xs w-40"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1">Max Alloc</Label>
              <Input
                name="maxAllocation"
                defaultValue={trader.maxAllocation ?? ''}
                className="h-7 text-xs w-20"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1">Max Daily</Label>
              <Input
                name="maxDailyAlloc"
                defaultValue={trader.maxDailyAlloc ?? ''}
                className="h-7 text-xs w-20"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1">Notes</Label>
              <Input
                name="notes"
                defaultValue={trader.notes ?? ''}
                className="h-7 text-xs w-32"
              />
            </div>
            <Button type="submit" size="xs">
              Save
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
        </TableCell>
        <TableCell />
      </TableRow>
    );
  }

  return (
    <TableRow>
      <TableCell className="px-4 font-medium text-foreground">{trader.name}</TableCell>
      <TableCell className="px-4">
        <form action={toggleTrader} className="inline">
          <input type="hidden" name="name" value={trader.name} />
          <input type="hidden" name="enabled" value={String(trader.enabled)} />
          <button type="submit">
            <Switch
              checked={!!trader.enabled}
              size="sm"
              tabIndex={-1}
              className="pointer-events-none"
            />
          </button>
        </form>
      </TableCell>
      <TableCell className="px-4 text-xs text-muted-foreground">{strategies.join(', ')}</TableCell>
      <TableCell className="px-4 text-muted-foreground">{trader.maxAllocation ?? '--'}</TableCell>
      <TableCell className="px-4 text-muted-foreground">{trader.maxDailyAlloc ?? '--'}</TableCell>
      <TableCell className="px-4 text-muted-foreground text-xs">{trader.notes ?? '--'}</TableCell>
      <TableCell className="px-4">
        <div className="flex gap-2">
          <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <form action={deleteTrader}>
            <input type="hidden" name="name" value={trader.name} />
            <Button
              type="submit"
              variant="ghost"
              size="xs"
              className="text-red-400 hover:text-red-300"
              onClick={(e) => {
                if (!confirm(`Delete trader "${trader.name}"?`)) {
                  e.preventDefault();
                }
              }}
            >
              Delete
            </Button>
          </form>
        </div>
      </TableCell>
    </TableRow>
  );
}

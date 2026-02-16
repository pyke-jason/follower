'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { setSecret, deleteSecret } from './actions';
import type { SecretEntry } from './actions';

function SecretRow({ entry }: { entry: SecretEntry }) {
  const [editing, setEditing] = useState(false);
  const [setResult, setDispatch, setPending] = useActionState(setSecret, null);
  const [delResult, delDispatch, delPending] = useActionState(deleteSecret, null);

  // Reset editing after successful save
  if (setResult?.ok && editing) {
    setEditing(false);
  }

  return (
    <tr className="border-b border-border">
      <td className="py-2 pr-4 font-mono text-xs">{entry.key}</td>
      <td className="py-2 pr-4">
        {entry.isSet ? (
          <span className="text-xs text-profit">set</span>
        ) : (
          <span className="text-xs text-muted-foreground">not set</span>
        )}
      </td>
      <td className="py-2">
        {editing ? (
          <form action={setDispatch} className="flex items-center gap-2">
            <input type="hidden" name="key" value={entry.key} />
            <Input
              name="value"
              type="password"
              placeholder="Enter value..."
              className="h-7 text-xs w-64"
              autoFocus
            />
            <Button type="submit" size="xs" disabled={setPending}>
              {setPending ? 'Saving...' : 'Save'}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            {setResult && !setResult.ok && (
              <span className="text-xs text-destructive">{setResult.error}</span>
            )}
          </form>
        ) : (
          <div className="flex items-center gap-2">
            <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
            {entry.isSet && (
              <form action={delDispatch}>
                <input type="hidden" name="key" value={entry.key} />
                <Button type="submit" size="xs" variant="ghost" className="text-destructive hover:text-destructive/80" disabled={delPending}>
                  {delPending ? 'Removing...' : 'Remove'}
                </Button>
              </form>
            )}
            {delResult && !delResult.ok && (
              <span className="text-xs text-destructive">{delResult.error}</span>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

export function SecretsTable({ entries }: { entries: SecretEntry[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="py-2 pr-4 font-medium">Key</th>
          <th className="py-2 pr-4 font-medium w-16">Status</th>
          <th className="py-2 font-medium">Actions</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <SecretRow key={entry.key} entry={entry} />
        ))}
      </tbody>
    </table>
  );
}

import { useMemo, useState } from 'react';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DataTable } from '@/components/data-table';
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
import { toast } from 'sonner';
import type { Column } from '@/lib/api-types';

export type SecretEntry = { key: string; isSet: boolean };

type FlatSecret = SecretEntry & { group: string };

// ── Actions cell (needs hooks for edit state + mutation) ─────────

function SecretActions({
  entry,
  onRequestDelete,
}: {
  entry: FlatSecret;
  onRequestDelete: (key: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const setMut = useApiMutation<{ key: string; value: string }>('POST', '/settings/secrets', {
    invalidate: [['settings-secrets']],
    onSuccess: () => { setEditing(false); setValue(''); setError(null); toast.success('Secret saved'); },
    onError: (err) => setError(err.message),
  });

  if (editing) {
    return (
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) {
            setMut.mutate({ key: entry.key, value: value.trim() });
          }
        }}
      >
        <Input
          type="password"
          placeholder="Enter value..."
          className="h-7 text-xs w-64"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit" size="xs" disabled={setMut.isPending}>
          {setMut.isPending ? 'Saving...' : 'Save'}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => { setEditing(false); setValue(''); setError(null); }}>
          Cancel
        </Button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </form>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
        Edit
      </Button>
      {entry.isSet && (
        <Button
          size="xs"
          variant="ghost"
          className="text-destructive hover:text-destructive/80"
          onClick={() => onRequestDelete(entry.key)}
        >
          Remove
        </Button>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

// ── Group classification ─────────────────────────────────────────

function getGroup(key: string): string {
  if (key.startsWith('IBKR_')) return 'Interactive Brokers';
  if (key.startsWith('ONE_OP_')) return 'OneOption';
  if (key.includes('API_KEY') || key.includes('ANTHROPIC') || key.includes('DATABENTO')) return 'API Keys';
  if (key.startsWith('DISCORD_') || key.startsWith('PUSHOVER_')) return 'Alerts';
  return 'General';
}

function flattenWithGroups(entries: SecretEntry[]): FlatSecret[] {
  // Preserve original group ordering
  const groups: Record<string, FlatSecret[]> = {};
  const order: string[] = [];

  for (const entry of entries) {
    const group = getGroup(entry.key);
    if (!groups[group]) {
      groups[group] = [];
      order.push(group);
    }
    groups[group].push({ ...entry, group });
  }

  return order.flatMap((g) => groups[g]);
}

// ── Columns ──────────────────────────────────────────────────────

function buildColumns(onRequestDelete: (key: string) => void): Column<FlatSecret>[] {
  return [
    {
      key: 'group',
      label: 'Group',
      sortable: true,
      className: 'w-[140px]',
      render: (row) => (
        <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
          {row.group}
        </span>
      ),
    },
    {
      key: 'key',
      label: 'Key',
      sortable: true,
      render: (row) => <span className="font-mono text-xs">{row.key}</span>,
    },
    {
      key: 'isSet',
      label: 'Status',
      className: 'w-[80px]',
      render: (row) =>
        row.isSet ? (
          <span className="text-xs text-profit">set</span>
        ) : (
          <span className="text-xs text-muted-foreground">not set</span>
        ),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (row) => <SecretActions entry={row} onRequestDelete={onRequestDelete} />,
    },
  ];
}

// ── SecretsTable ─────────────────────────────────────────────────

export function SecretsTable({ entries }: { entries: SecretEntry[] }) {
  const [pendingDeleteKey, setPendingDeleteKey] = useState<string | null>(null);
  const flat = useMemo(() => flattenWithGroups(entries), [entries]);
  const columns = useMemo(() => buildColumns(setPendingDeleteKey), []);

  const delMut = useApiMutation<string>('DELETE', (key) => `/settings/secrets/${encodeURIComponent(key)}`, {
    invalidate: [['settings-secrets']],
    onSuccess: () => { setPendingDeleteKey(null); toast.success('Secret removed'); },
    onError: (err) => toast.error(err.message),
  });

  return (
    <>
      <DataTable
        columns={columns}
        data={flat}
        defaultSort={{ column: 'group' }}
        className="h-[600px]"
      />

      <AlertDialog open={pendingDeleteKey !== null} onOpenChange={(open) => { if (!open) setPendingDeleteKey(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDeleteKey}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the secret from macOS Keychain. Services depending on it will stop working.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={delMut.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={delMut.isPending}
              onClick={() => { if (pendingDeleteKey) delMut.mutate(pendingDeleteKey); }}
            >
              {delMut.isPending ? 'Removing...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

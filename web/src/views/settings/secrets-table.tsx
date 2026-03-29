import { Fragment, useState } from 'react';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
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

export type SecretEntry = { key: string; isSet: boolean };

function SecretRow({
  entry,
  onRequestDelete,
}: {
  entry: SecretEntry;
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

  return (
    <TableRow>
      <TableCell className="py-2 pr-4 font-mono text-xs">{entry.key}</TableCell>
      <TableCell className="py-2 pr-4">
        {entry.isSet ? (
          <span className="text-xs text-profit">set</span>
        ) : (
          <span className="text-xs text-muted-foreground">not set</span>
        )}
      </TableCell>
      <TableCell className="py-2">
        {editing ? (
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
        ) : (
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
        )}
      </TableCell>
    </TableRow>
  );
}

function groupSecrets(entries: SecretEntry[]): { label: string; entries: SecretEntry[] }[] {
  const groups: Record<string, SecretEntry[]> = {};
  const order: string[] = [];

  for (const entry of entries) {
    let group: string;
    if (entry.key.startsWith('TS_')) group = 'TradeStation';
    else if (entry.key.startsWith('IBKR_')) group = 'Interactive Brokers';
    else if (entry.key.startsWith('ONE_OP_')) group = 'OneOption';
    else if (entry.key.includes('API_KEY') || entry.key.includes('ANTHROPIC') || entry.key.includes('DATABENTO')) group = 'API Keys';
    else if (entry.key.startsWith('DISCORD_') || entry.key.startsWith('PUSHOVER_')) group = 'Alerts';
    else group = 'General';

    if (!groups[group]) {
      groups[group] = [];
      order.push(group);
    }
    groups[group].push(entry);
  }

  return order.map((label) => ({ label, entries: groups[label] }));
}

export function SecretsTable({ entries }: { entries: SecretEntry[] }) {
  const grouped = groupSecrets(entries);
  const [pendingDeleteKey, setPendingDeleteKey] = useState<string | null>(null);

  const delMut = useApiMutation<string>('DELETE', (key) => `/settings/secrets/${encodeURIComponent(key)}`, {
    invalidate: [['settings-secrets']],
    onSuccess: () => { setPendingDeleteKey(null); toast.success('Secret removed'); },
    onError: (err) => toast.error(err.message),
  });

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="text-left text-xs text-muted-foreground">
            <TableHead className="py-2 pr-4 font-medium">Key</TableHead>
            <TableHead className="py-2 pr-4 font-medium w-16">Status</TableHead>
            <TableHead className="py-2 font-medium">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {grouped.map(({ label, entries: groupEntries }) => (
            <Fragment key={label}>
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="pt-5 pb-1">
                  <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                    {label}
                  </span>
                </TableCell>
              </TableRow>
              {groupEntries.map((entry) => (
                <SecretRow
                  key={entry.key}
                  entry={entry}
                  onRequestDelete={setPendingDeleteKey}
                />
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>

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

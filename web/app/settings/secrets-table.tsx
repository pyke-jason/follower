import { useState } from 'react';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type SecretEntry = { key: string; isSet: boolean };

function SecretRow({ entry }: { entry: SecretEntry }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const setMut = useApiMutation<{ key: string; value: string }>('POST', '/settings/secrets', {
    invalidate: [['settings-secrets']],
    onSuccess: () => { setEditing(false); setValue(''); setError(null); },
    onError: (err) => setError(err.message),
  });

  const delMut = useApiMutation<string>('DELETE', (key) => `/settings/secrets/${encodeURIComponent(key)}`, {
    invalidate: [['settings-secrets']],
    onSuccess: () => setError(null),
    onError: (err) => setError(err.message),
  });

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
                disabled={delMut.isPending}
                onClick={() => delMut.mutate(entry.key)}
              >
                {delMut.isPending ? 'Removing...' : 'Remove'}
              </Button>
            )}
            {error && <span className="text-xs text-destructive">{error}</span>}
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

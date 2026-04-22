import { useState } from 'react';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';

export type RiskSettings = {
  maxTotalPositions: number;
  defaultMaxTotalPositions: number;
  overridden: boolean;
};

export function RiskLimits({ settings }: { settings: RiskSettings }) {
  const [value, setValue] = useState(String(settings.maxTotalPositions));
  const [error, setError] = useState<string | null>(null);

  const save = useApiMutation<{ maxTotalPositions: number }>('POST', '/settings/risk', {
    invalidate: [['settings-risk']],
    onSuccess: () => { setError(null); toast.success('Risk limit saved (takes effect on restart)'); },
    onError: (err) => setError(err.message),
  });

  const parsed = parseInt(value, 10);
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= 1000;
  const dirty = valid && parsed !== settings.maxTotalPositions;

  return (
    <form
      className="flex items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate({ maxTotalPositions: parsed });
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="maxTotalPositions" className="text-xs font-medium text-muted-foreground">
          Max concurrent positions
        </label>
        <Input
          id="maxTotalPositions"
          type="number"
          min={1}
          max={1000}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-9 w-32"
        />
      </div>
      <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
        {save.isPending ? 'Saving...' : 'Save'}
      </Button>
      <div className="text-xs text-muted-foreground pb-2">
        Default {settings.defaultMaxTotalPositions}
        {settings.overridden && settings.maxTotalPositions !== settings.defaultMaxTotalPositions
          ? ` · currently overridden to ${settings.maxTotalPositions}`
          : ''}
      </div>
      {error && <span className="text-xs text-destructive pb-2">{error}</span>}
    </form>
  );
}

import { useApiMutation } from '@/hooks/use-api-mutation';
import { Button } from '@/components/ui/button';

type Result = { ok: boolean; error?: string };

export function TestButton({ service }: { service: 'discord' | 'pushover' }) {
  const mut = useApiMutation<void, Result>('POST', `/settings/test/${service}`);

  return (
    <div className="flex items-center gap-3">
      <Button
        size="sm"
        disabled={mut.isPending}
        onClick={() => mut.mutate()}
      >
        {mut.isPending ? 'Sending...' : 'Send Test'}
      </Button>
      {mut.data && (
        <span className={`text-sm ${mut.data.ok ? 'text-profit' : 'text-destructive'}`}>
          {mut.data.ok ? 'Sent successfully' : mut.data.error}
        </span>
      )}
      {mut.error && (
        <span className="text-sm text-destructive">{mut.error.message}</span>
      )}
    </div>
  );
}

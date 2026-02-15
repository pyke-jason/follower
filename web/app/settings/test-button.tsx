'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';

type Result = { ok: boolean; error?: string } | null;

export function TestButton({ action }: { action: () => Promise<Result> }) {
  const [result, dispatch, pending] = useActionState<Result, void>(
    async () => action(),
    null,
  );

  return (
    <div className="flex items-center gap-3">
      <form action={() => dispatch()}>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Sending...' : 'Send Test'}
        </Button>
      </form>
      {result && (
        <span className={`text-sm ${result.ok ? 'text-green-500' : 'text-red-500'}`}>
          {result.ok ? 'Sent successfully' : result.error}
        </span>
      )}
    </div>
  );
}

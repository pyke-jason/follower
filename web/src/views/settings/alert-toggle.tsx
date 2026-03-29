import { useState } from 'react';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';

export type ToggleId = 'discord' | 'pushover' | 'ingestion';

export function SettingToggle({
  id,
  enabled,
}: {
  id: ToggleId;
  enabled: boolean;
}) {
  const [optimistic, setOptimistic] = useState(enabled);

  const mut = useApiMutation<boolean>('POST', `/settings/toggles/${id}`, {
    body: (checked) => ({ enabled: checked }),
    onMutate: (checked) => setOptimistic(checked),
    invalidate: [['settings-toggles']],
    onSuccess: () => toast.success('Setting updated'),
    onError: () => { setOptimistic(enabled); toast.error('Failed to update setting'); },
  });

  return (
    <Switch
      checked={optimistic}
      disabled={mut.isPending}
      onCheckedChange={(checked) => mut.mutate(checked)}
    />
  );
}

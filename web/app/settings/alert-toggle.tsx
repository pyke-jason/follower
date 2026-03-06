import { useState } from 'react';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { Switch } from '@/components/ui/switch';

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
    onError: () => setOptimistic(enabled),
  });

  return (
    <Switch
      checked={optimistic}
      disabled={mut.isPending}
      onCheckedChange={(checked) => mut.mutate(checked)}
    />
  );
}

'use client';

import { useTransition, useOptimistic } from 'react';
import { Switch } from '@/components/ui/switch';
import { toggleSetting, type ToggleId } from './actions';

export function SettingToggle({
  id,
  enabled,
}: {
  id: ToggleId;
  enabled: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(enabled);

  return (
    <Switch
      checked={optimistic}
      disabled={pending}
      onCheckedChange={(checked) => {
        startTransition(async () => {
          setOptimistic(checked);
          await toggleSetting(id, checked);
        });
      }}
    />
  );
}

'use client';

import { useRef, useEffect } from 'react';
import { useTradesStore, type TradesHydration } from '@/stores/trades-store';

export type { TradesHydration };

export function TradesHydrator({ data }: { data: TradesHydration }) {
  const hydrate = useTradesStore((s) => s.hydrate);
  const initialized = useRef(false);
  const dataRef = useRef(data);

  if (!initialized.current) {
    hydrate(data);
    initialized.current = true;
  }

  useEffect(() => {
    if (dataRef.current === data) return;
    dataRef.current = data;
    hydrate(data);
  }, [data, hydrate]);

  return null;
}

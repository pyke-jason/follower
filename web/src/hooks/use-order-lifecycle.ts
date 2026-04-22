import { useEffect, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiMutation } from '@/hooks/use-api-mutation';
import type { OrderEntryParams, WorkingOrder } from '@/lib/order-types';

type PlaceOrderResponse = WorkingOrder;
type ModifyOrderVars = { orderId: string; limitPrice: number };
type CancelOrderVars = { orderId: string };

export function useOrderLifecycle(tradeId: string) {
  const qc = useQueryClient();
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);

  const placeOrder = useApiMutation<OrderEntryParams, PlaceOrderResponse>(
    'POST',
    '/orders',
    {
      invalidate: [['trade', tradeId], ['orders', tradeId]],
      onSuccess: (data) => setActiveOrderId(data.orderId),
    },
  );

  const modifyOrder = useApiMutation<ModifyOrderVars, WorkingOrder>(
    'PUT',
    (v) => `/orders/${v.orderId}`,
    {
      body: (v) => ({ limitPrice: v.limitPrice }),
      invalidate: [['order', activeOrderId], ['orders', tradeId]],
    },
  );

  const cancelOrder = useApiMutation<CancelOrderVars, WorkingOrder>(
    'DELETE',
    (v) => `/orders/${v.orderId}`,
    {
      invalidate: [['order', activeOrderId], ['orders', tradeId], ['trade', tradeId]],
      onSuccess: () => setActiveOrderId(null),
    },
  );

  const orderStatusQuery = useQuery<WorkingOrder>({
    queryKey: ['order', activeOrderId],
    queryFn: () =>
      import('@/lib/api').then((m) =>
        m.api<WorkingOrder>(`/orders/${activeOrderId}`),
      ),
    enabled: activeOrderId != null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!status) return 2000;
      if (status === 'FILLED' || status === 'CANCELLED' || status === 'REJECTED') return false;
      return 2000;
    },
    staleTime: 500,
  });

  const isTerminal =
    orderStatusQuery.data?.status === 'FILLED' ||
    orderStatusQuery.data?.status === 'CANCELLED' ||
    orderStatusQuery.data?.status === 'REJECTED';

  useEffect(() => {
    if (!isTerminal) return;
    qc.invalidateQueries({ queryKey: ['trade', tradeId] });
    qc.invalidateQueries({ queryKey: ['orders', tradeId] });
  }, [isTerminal, qc, tradeId]);

  useEffect(() => {
    if (orderStatusQuery.data?.status !== 'FILLED') return;

    qc.refetchQueries({ queryKey: ['trade', tradeId] });

    let attempts = 0;
    const interval = window.setInterval(() => {
      attempts += 1;
      qc.invalidateQueries({ queryKey: ['trade', tradeId] });
      qc.refetchQueries({ queryKey: ['trade', tradeId] });
      if (attempts >= 4) window.clearInterval(interval);
    }, 1500);

    return () => window.clearInterval(interval);
  }, [orderStatusQuery.data?.status, qc, tradeId]);

  const reset = useCallback(() => {
    setActiveOrderId(null);
    qc.invalidateQueries({ queryKey: ['trade', tradeId] });
  }, [qc, tradeId]);

  return {
    activeOrderId,
    placeOrder,
    modifyOrder,
    cancelOrder,
    orderStatus: orderStatusQuery.data ?? null,
    isPolling: orderStatusQuery.isFetching,
    isTerminal,
    reset,
  };
}

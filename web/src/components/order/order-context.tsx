import { createContext, useContext, type ReactNode } from 'react';
import { useQuote } from '@/hooks/use-quote';
import { useOrderLifecycle } from '@/hooks/use-order-lifecycle';
import { defaultTickSize } from '@/lib/order-types';
import type { QuoteData } from '@/lib/order-types';
import type { Trade } from '@src/db/schema';

type OrderContextValue = {
  trade: Trade;
  quote: QuoteData | null;
  quoteLoading: boolean;
  tickSize: number;
  lifecycle: ReturnType<typeof useOrderLifecycle>;
};

const OrderContext = createContext<OrderContextValue | undefined>(undefined);

export function useOrderContext() {
  const ctx = useContext(OrderContext);
  if (!ctx) throw new Error('useOrderContext must be used within <OrderProvider>');
  return ctx;
}

export function OrderProvider({ trade, children }: { trade: Trade; children: ReactNode }) {
  const quoteSymbol = trade.legs[0]?.symbol ?? trade.symbol;
  const { data: quote, isLoading: quoteLoading } = useQuote({
    symbol: quoteSymbol,
    channelId: trade.channelId,
  });
  const lifecycle = useOrderLifecycle(trade.id);
  const tickSize = quote ? defaultTickSize(quote.ask) : 0.05;

  return (
    <OrderContext.Provider value={{ trade, quote: quote ?? null, quoteLoading, tickSize, lifecycle }}>
      {children}
    </OrderContext.Provider>
  );
}

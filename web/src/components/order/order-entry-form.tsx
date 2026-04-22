import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { LimitPriceInput } from './limit-price-input';
import { useOrderContext } from './order-context';
import { formatCurrency } from '@/lib/format';
import { OrderFormValuesSchema, type OrderFormValues } from '@/lib/order-types';
import { tradeQty } from '@src/lib/trade';

export function OrderEntryForm() {
  const { trade, quote, tickSize, lifecycle } = useOrderContext();

  const form = useForm<OrderFormValues>({
    resolver: zodResolver(OrderFormValuesSchema),
    defaultValues: {
      orderType: 'LIMIT',
      limitPrice: quote?.mid ?? undefined,
      quantity: tradeQty(trade.quantity),
    },
  });

  const orderType = form.watch('orderType');
  const limitPrice = form.watch('limitPrice');
  const quantity = form.watch('quantity');

  useEffect(() => {
    if (quote?.mid && !form.getValues('limitPrice')) {
      form.setValue('limitPrice', quote.mid);
    }
  }, [quote?.mid, form]);

  const isStock = trade.strategy === 'STOCK';
  const multiplier = isStock ? 1 : 100;
  const price = orderType === 'LIMIT' ? (limitPrice ?? 0) : (quote?.ask ?? 0);
  const estimatedTotal = price * (quantity ?? 0) * multiplier;

  const onSubmit = (values: OrderFormValues) => {
    lifecycle.placeOrder.mutate({
      tradeId: trade.id,
      channelId: trade.channelId,
      orderType: values.orderType,
      limitPrice: values.orderType === 'LIMIT' ? values.limitPrice : undefined,
      quantity: values.quantity,
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
        <FormField
          control={form.control}
          name="orderType"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between">
              <FormLabel className="text-[10px] uppercase tracking-wider">Order Type</FormLabel>
              <FormControl>
                <ToggleGroup
                  type="single"
                  value={field.value}
                  onValueChange={(v) => { if (v) field.onChange(v); }}
                  variant="outline"
                  size="sm"
                >
                  <ToggleGroupItem value="LIMIT" className="text-xs px-3">Limit</ToggleGroupItem>
                  <ToggleGroupItem value="MARKET" className="text-xs px-3">Market</ToggleGroupItem>
                </ToggleGroup>
              </FormControl>
            </FormItem>
          )}
        />

        {orderType === 'LIMIT' && (
          <FormField
            control={form.control}
            name="limitPrice"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between">
                <FormLabel className="text-[10px] uppercase tracking-wider">Limit Price</FormLabel>
                <div>
                  <FormControl>
                    <LimitPriceInput
                      value={field.value ?? 0}
                      onChange={field.onChange}
                      tickSize={tickSize}
                      midpoint={quote?.mid}
                      disabled={lifecycle.placeOrder.isPending}
                    />
                  </FormControl>
                  <FormMessage />
                </div>
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control}
          name="quantity"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between">
              <FormLabel className="text-[10px] uppercase tracking-wider">Quantity</FormLabel>
              <div>
                <FormControl>
                  <Input
                    type="number"
                    min={1}
                    value={field.value}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!isNaN(v)) field.onChange(v);
                    }}
                    disabled={lifecycle.placeOrder.isPending}
                    className="h-8 w-20 text-center font-mono text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </FormControl>
                <FormMessage />
              </div>
            </FormItem>
          )}
        />

        <div className="flex items-center justify-between border-t pt-2">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Est. Total
          </span>
          <span className="text-sm font-mono tabular-nums font-medium">
            {estimatedTotal > 0 ? formatCurrency(estimatedTotal) : '--'}
          </span>
        </div>

        <Button
          type="submit"
          className="w-full"
          variant="destructive"
          disabled={lifecycle.placeOrder.isPending}
        >
          {lifecycle.placeOrder.isPending
            ? 'Submitting...'
            : `Close ${orderType === 'LIMIT' ? 'Limit' : 'Market'}`}
        </Button>
      </form>
    </Form>
  );
}

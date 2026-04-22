import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form';
import { LimitPriceInput } from './limit-price-input';
import { useOrderContext } from './order-context';
import { formatCurrency } from '@/lib/format';
import { relativeTime } from '@/lib/format';
import { ModifyOrderParamsSchema, type ModifyOrderParams } from '@/lib/order-types';
import { cn } from '@/lib/utils';
import { Pencil, X, Check, Loader2 } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  PENDING: 'secondary',
  OPEN: 'default',
  FILLED: 'default',
  CANCELLED: 'outline',
  REJECTED: 'destructive',
};

export function WorkingOrderCard() {
  const { quote, tickSize, lifecycle } = useOrderContext();
  const { orderStatus, modifyOrder, cancelOrder, isPolling, isTerminal, reset } = lifecycle;
  const [editing, setEditing] = useState(false);

  if (!orderStatus) return null;

  const { orderId, status, currentLimitPrice, limitPrice: origPrice, filledPrice, filledQuantity, commission, placedAt } = orderStatus;

  const displayPrice = currentLimitPrice ?? origPrice;

  return (
    <div className={cn(
      'rounded-md border p-3 space-y-2',
      status === 'FILLED' && 'border-profit/40 bg-profit/5',
      status === 'REJECTED' && 'border-destructive/40 bg-destructive/5',
    )}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant={statusVariant[status] ?? 'outline'}>{status}</Badge>
          {isPolling && !isTerminal && <Spinner className="size-3" />}
        </div>
        <span className="text-[10px] text-muted-foreground">{relativeTime(placedAt)} ago</span>
      </div>

      {/* Price info */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {displayPrice != null && (
          <>
            <span className="text-muted-foreground">Limit</span>
            <span className="font-mono tabular-nums text-right">{formatCurrency(displayPrice)}</span>
          </>
        )}
        {filledPrice != null && (
          <>
            <span className="text-muted-foreground">Filled</span>
            <span className="font-mono tabular-nums text-right">{formatCurrency(filledPrice)}</span>
          </>
        )}
        {filledQuantity != null && (
          <>
            <span className="text-muted-foreground">Qty filled</span>
            <span className="font-mono tabular-nums text-right">{filledQuantity}</span>
          </>
        )}
        {commission != null && (
          <>
            <span className="text-muted-foreground">Commission</span>
            <span className="font-mono tabular-nums text-right">{formatCurrency(commission)}</span>
          </>
        )}
      </div>

      {/* Actions for working orders */}
      {!isTerminal && (
        <div className="flex items-center gap-1.5 pt-1 border-t">
          {editing ? (
            <ModifyForm
              currentPrice={displayPrice ?? quote?.mid ?? 0}
              tickSize={tickSize}
              midpoint={quote?.mid}
              isPending={modifyOrder.isPending}
              onSubmit={(p) => {
                modifyOrder.mutate({ orderId, limitPrice: p }, {
                  onSuccess: () => setEditing(false),
                });
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              <Button variant="outline" size="xs" className="text-xs gap-1" onClick={() => setEditing(true)}>
                <Pencil className="size-3" /> Modify
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="xs" className="text-xs gap-1 text-destructive hover:text-destructive">
                    <X className="size-3" /> Cancel
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Cancel order?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will cancel the working order. You can place a new one after.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep order</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={cancelOrder.isPending}
                      onClick={() => cancelOrder.mutate({ orderId })}
                    >
                      {cancelOrder.isPending ? 'Cancelling...' : 'Cancel order'}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </div>
      )}

      {isTerminal && status !== 'FILLED' && (
        <Button variant="ghost" size="xs" className="w-full text-xs" onClick={reset}>
          Dismiss
        </Button>
      )}

      {status === 'FILLED' && (
        <div className="rounded-md border border-profit/30 bg-profit/5 px-3 py-2 text-xs text-profit">
          Exit filled. The trade detail will collapse into its closed state as soon as the story query refreshes.
        </div>
      )}
    </div>
  );
}

function ModifyForm({
  currentPrice,
  tickSize,
  midpoint,
  isPending,
  onSubmit,
  onCancel,
}: {
  currentPrice: number;
  tickSize: number;
  midpoint?: number;
  isPending: boolean;
  onSubmit: (price: number) => void;
  onCancel: () => void;
}) {
  const form = useForm<ModifyOrderParams>({
    resolver: zodResolver(ModifyOrderParamsSchema),
    defaultValues: { limitPrice: currentPrice },
  });

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((v) => onSubmit(v.limitPrice))}
        className="flex items-center gap-1.5 w-full"
      >
        <FormField
          control={form.control}
          name="limitPrice"
          render={({ field }) => (
            <FormItem className="flex-1">
              <FormControl>
                <LimitPriceInput
                  value={field.value}
                  onChange={field.onChange}
                  tickSize={tickSize}
                  midpoint={midpoint}
                  disabled={isPending}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" size="icon" variant="ghost" className="size-7" disabled={isPending}>
          {isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
        </Button>
        <Button type="button" size="icon" variant="ghost" className="size-7" onClick={onCancel} disabled={isPending}>
          <X className="size-3.5" />
        </Button>
      </form>
    </Form>
  );
}

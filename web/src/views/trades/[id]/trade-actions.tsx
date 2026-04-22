import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { useApiMutation } from '@/hooks/use-api-mutation';
import { toast } from 'sonner';
import { formatLegsSummary } from '@src/lib/trade';
import type { Trade } from '@src/db/schema';

export function TradeActions({ trade }: { trade: Trade }) {
  const forceExit = useApiMutation('POST', `/trades/${trade.id}/force-exit`, {
    invalidate: [['trade', trade.id]],
    onSuccess: () => toast.success(`Force-exit submitted for ${trade.symbol}`),
    onError: (err) => toast.error(`Force-exit failed: ${err.message}`),
  });

  if (trade.status !== 'OPEN') return null;

  const contractSummary = formatLegsSummary(trade.legs, trade.strategy);

  return (
    <div className="flex items-center gap-2">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" size="sm">
            <X className="h-3.5 w-3.5" />
            Force close
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force close {trade.symbol}?</AlertDialogTitle>
            <AlertDialogDescription>
              This submits a market exit for {trade.quantity ?? 1}×{' '}
              <span className="font-mono">{contractSummary || trade.strategy}</span>{' '}
              via IBKR. The bot will stop tracking this position.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={forceExit.isPending}
              onClick={() => forceExit.mutate()}
            >
              {forceExit.isPending ? 'Submitting...' : 'Force close'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

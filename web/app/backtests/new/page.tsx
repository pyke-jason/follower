import { getTrackedTraders } from '@/lib/queries';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { startBacktest } from '../actions';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function NewBacktestPage() {
  const traders = await getTrackedTraders();
  const traderNames = traders.map((t) => t.name).join(', ');

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-3">
        <Link href="/backtests" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Backtests
        </Link>
        <h2 className="text-xl font-bold text-foreground">New Backtest</h2>
      </div>

      <Card className="py-4 gap-3">
        <CardContent>
          <form action={startBacktest} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs text-muted-foreground mb-1">Start Date</Label>
                <Input
                  name="startDate"
                  type="date"
                  required
                  defaultValue="2025-09-01"
                  className="h-9"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1">End Date</Label>
                <Input
                  name="endDate"
                  type="date"
                  required
                  defaultValue="2025-12-27"
                  className="h-9"
                />
              </div>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground mb-1">Traders (comma-separated)</Label>
              <Input
                name="traders"
                required
                placeholder="Arethra, Pete"
                defaultValue={traderNames}
                className="h-9"
              />
            </div>

            <div className="flex items-center gap-3">
              <Switch name="useAgent" id="useAgent" />
              <Label htmlFor="useAgent" className="text-sm">Use agent for low-confidence messages</Label>
            </div>

            <div className="flex items-center gap-3">
              <Switch name="useQuoteTape" id="useQuoteTape" defaultChecked />
              <Label htmlFor="useQuoteTape" className="text-sm">Use quote tape (Databento)</Label>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs text-muted-foreground mb-1">Max Agent Calls</Label>
                <Input
                  name="maxAgentCalls"
                  type="number"
                  defaultValue="100"
                  min="0"
                  className="h-9"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1">Slippage %</Label>
                <Input
                  name="slippagePct"
                  type="number"
                  step="0.001"
                  defaultValue="0.01"
                  min="0"
                  className="h-9"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button type="submit">Start Backtest</Button>
              <Button type="button" variant="ghost" asChild>
                <Link href="/backtests">Cancel</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

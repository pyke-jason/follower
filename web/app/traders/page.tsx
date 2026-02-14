import { getTrackedTraders } from '@/lib/queries';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { addTrader } from './actions';
import { TraderEditRow } from './trader-edit-row';

export const dynamic = 'force-dynamic';

export default async function TradersPage() {
  const traders = await getTrackedTraders();

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-foreground">Tracked Traders</h2>

      <Card className="py-0 gap-0 overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs text-muted-foreground uppercase px-4">Name</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase px-4">Enabled</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase px-4">Strategies</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase px-4">Max Alloc</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase px-4">Max Daily</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase px-4">Notes</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase px-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {traders.map((trader) => (
                <TraderEditRow key={trader.name} trader={trader} />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Add Trader Form */}
      <Card className="py-4 gap-3">
        <CardHeader className="py-0">
          <CardTitle className="text-sm">Add Trader</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={addTrader} className="flex items-end gap-3 flex-wrap">
            <div>
              <Label className="text-xs text-muted-foreground mb-1">Name</Label>
              <Input
                name="name"
                required
                placeholder="Trader name"
                className="h-8 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1">Strategies</Label>
              <Input
                name="strategies"
                defaultValue="CDS,PDS,CALL,PUT,STOCK"
                className="h-8 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1">Max Alloc</Label>
              <Input
                name="maxAllocation"
                defaultValue="5000"
                className="h-8 text-sm w-24"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1">Max Daily</Label>
              <Input
                name="maxDailyAlloc"
                defaultValue="10000"
                className="h-8 text-sm w-24"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1">Notes</Label>
              <Input
                name="notes"
                placeholder="Optional"
                className="h-8 text-sm"
              />
            </div>
            <Button type="submit" size="sm">
              Add
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

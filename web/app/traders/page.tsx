import { getTrackedTraders, getDistinctAuthors } from '@/lib/queries';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { addTrader } from './actions';
import { TraderEditRow } from './trader-edit-row';
import { TraderCombobox } from './trader-combobox';

export const dynamic = 'force-dynamic';

export default async function TradersPage() {
  const [traders, authors] = await Promise.all([
    getTrackedTraders(),
    getDistinctAuthors(),
  ]);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-foreground">Tracked Traders</h2>

      <Card className="py-0 gap-0 overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>Strategies</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead>Actions</TableHead>
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
              <TraderCombobox
                key={traders.length}
                existingTraders={traders.map((t) => t.name)}
                authors={authors}
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

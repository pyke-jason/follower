import { useTradeFilters } from './trade-filters';
import { TradesTableClient } from './trades-table-client';
import { EmptyState } from './empty-state';
import { Button } from '@/components/ui/button';

export function FilteredTradesView() {
  const { filteredTrades, hasFilters, clearFilters } = useTradeFilters();

  if (filteredTrades.length === 0 && hasFilters) {
    return (
      <EmptyState
        title="No trades matching filters"
        variant="filtered"
        action={(
          <Button variant="outline" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      />
    );
  }

  return (
    <TradesTableClient trades={filteredTrades} />
  );
}

import { useTradesStore } from '@/stores/trades-store';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ActivityDetail } from './activity-detail';
import { TradeLabelSection } from './trade-label-section';
import type { TradeLabel } from '@src/local-api/http-schemas';

export function TradeDetailPanel({ onClose }: { onClose: () => void }) {
  const trade = useTradesStore((s) => {
    const id = s.selectedTradeId;
    return id ? s.trades.find((t) => t.id === id) ?? null : null;
  });
  const label: TradeLabel | undefined = useTradesStore((s) => {
    const id = s.selectedTradeId;
    return id ? s.labelsByTradeId[id] : undefined;
  });
  const story = useTradesStore((s) => s.story);
  const isLoading = useTradesStore((s) => s.isLoadingStory);
  const hasLabels = useTradesStore((s) => Object.keys(s.labelsByTradeId).length > 0);

  if (!trade) return null;

  const storyTrade = story?.trade ?? trade;

  if (isLoading && !story) {
    return (
      <div className="flex h-full flex-col">
        <div className="sticky top-0 z-10 flex justify-end border-b bg-background px-4 py-3">
          <Button variant="ghost" size="icon" aria-label="Close detail panel" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="px-4 py-6 text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!story) {
    return (
      <div className="flex h-full flex-col">
        <div className="sticky top-0 z-10 flex justify-end border-b bg-background px-4 py-3">
          <Button variant="ghost" size="icon" aria-label="Close detail panel" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="px-4 py-6 text-sm text-muted-foreground">Trade data not available</div>
      </div>
    );
  }

  return (
    <div className="px-4 py-4">
      <div className="space-y-5">
        <ActivityDetail
          story={story}
          compact
          backHref={null}
          heroActions={(
            <Button variant="ghost" size="icon" aria-label="Close detail panel" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        />

        {hasLabels && (
          <Card className="gap-0 overflow-hidden py-0">
            <CardHeader className="border-b px-4 py-3">
              <CardTitle className="text-sm font-medium">Label</CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <TradeLabelSection
                label={label}
                trade={storyTrade}
                systemDecision={story.decision}
              />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

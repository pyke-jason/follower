import { useRef, useEffect, useState } from 'react';
import { useQuote } from '@/hooks/use-quote';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

type QuoteStripProps = {
  symbol: string;
  channelId: string;
  enabled?: boolean;
};

type FlashDir = 'up' | 'down' | null;

function useFlash(value: number | undefined): FlashDir {
  const prev = useRef(value);
  const [flash, setFlash] = useState<FlashDir>(null);

  useEffect(() => {
    if (value == null || prev.current == null) {
      prev.current = value;
      return;
    }
    if (value > prev.current) setFlash('up');
    else if (value < prev.current) setFlash('down');
    prev.current = value;

    const t = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(t);
  }, [value]);

  return flash;
}

function QuoteCell({ label, value, decimals = 2 }: { label: string; value: number | undefined; decimals?: number }) {
  const flash = useFlash(value);
  return (
    <div className="flex flex-col items-center gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span
        className={cn(
          'text-sm font-mono tabular-nums font-medium transition-colors duration-300',
          flash === 'up' && 'text-profit',
          flash === 'down' && 'text-loss',
          !flash && 'text-foreground',
        )}
      >
        {value != null ? formatCurrency(value, decimals) : '--'}
      </span>
    </div>
  );
}

export function QuoteStrip({ symbol, channelId, enabled = true }: QuoteStripProps) {
  const { data, isLoading, isError } = useQuote({ symbol, channelId, enabled });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" />
        <span>Loading quote...</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex items-center justify-center py-2 text-sm text-muted-foreground">
        Quote unavailable
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/30 px-4 py-2">
      <QuoteCell label="Bid" value={data.bid} />
      <QuoteCell label="Ask" value={data.ask} />
      <QuoteCell label="Mid" value={data.mid} />
      <QuoteCell label="Last" value={data.last} />
      <QuoteCell label="Spread" value={data.spread} decimals={4} />
    </div>
  );
}

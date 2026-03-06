import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { Radio, ArrowRight, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { relativeTime, signalBorderColor } from '@/lib/format';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { api } from '@/lib/api';
import { Badge } from './badge';

interface Signal {
  message: {
    id: string;
    author: string;
    cleanText: string | null;
    actionHint: string | null;
    directionHint: string | null;
    badges: string[] | null;
    symbols: unknown[] | null;
    timestamp: string;
  };
  trade: {
    id: string;
    status: string;
    pnl: string | null;
    symbol: string;
  } | null;
}

function formatCurrency(value: string | number | null): string {
  if (value == null) return '--';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '--';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num);
}

function pnlColorClass(value: string | null): string {
  if (!value) return 'text-muted-foreground';
  const num = parseFloat(value);
  if (isNaN(num) || num === 0) return 'text-muted-foreground';
  return num > 0 ? 'text-profit' : 'text-loss';
}

export function SignalSheet() {
  const [searchParams] = useSearchParams();
  const channelId = searchParams.get('channel');
  const href = useScopedHref();
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    // Fetch recent signals via the existing messages API logic
    // We'll use a direct query endpoint
    const params = new URLSearchParams();
    params.set('signalsOnly', '1');
    params.set('limit', '20');
    if (channelId) params.set('channel', channelId);
    setLoadError(null);

    api<Signal[]>(`/signals?${params}`)
      .then(setSignals)
      .catch(() => {
        setSignals([]);
        setLoadError('Unable to load recent signals');
      });
  }, [open, channelId]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs font-normal px-2.5">
          <Radio className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="hidden sm:inline">Signals</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[400px] sm:w-[440px] p-0">
        <SheetHeader className="px-4 py-3 border-b">
          <SheetTitle className="text-sm font-medium">Recent Signals</SheetTitle>
        </SheetHeader>
        <ScrollArea className="h-[calc(100vh-8rem)]">
          {loadError ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Radio className="h-8 w-8 opacity-20 mb-3" />
              <p className="text-sm">{loadError}</p>
              <p className="text-xs mt-1 opacity-50">Check local API status and retry</p>
            </div>
          ) : signals.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Radio className="h-8 w-8 opacity-20 mb-3" />
              <p className="text-sm">No signals yet</p>
              <p className="text-xs mt-1 opacity-50">Trader messages will appear here</p>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {signals.map(({ message: m, trade: t }) => (
                <div
                  key={m.id}
                  className={`flex items-start gap-3 px-4 py-3 border-l-2 hover:bg-accent/30 transition-colors ${signalBorderColor(m.actionHint, m.directionHint)}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-semibold">{m.author}</span>
                      {m.actionHint && <Badge label={m.actionHint} />}
                      {m.directionHint && <Badge label={m.directionHint} />}
                      <span className="text-[10px] text-muted-foreground/50 ml-auto tabular-nums">
                        {relativeTime(m.timestamp)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                      {m.cleanText}
                    </p>
                  </div>
                  <div className="shrink-0 mt-1">
                    {t ? (
                      t.status === 'CLOSED' ? (
                        <span className={`flex items-center gap-1 text-[10px] font-semibold tabular-nums ${pnlColorClass(t.pnl)}`}>
                          <CheckCircle2 className="h-3 w-3" />
                          {formatCurrency(t.pnl)}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-[10px] text-info font-medium">
                          <Clock className="h-3 w-3" />
                          Open
                        </span>
                      )
                    ) : m.actionHint ? (
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground/40">
                        <XCircle className="h-3 w-3" />
                        Skip
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
        <div className="border-t px-4 py-3">
          <Link
            to={href('/messages')}
            onClick={() => setOpen(false)}
            className="flex items-center justify-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            View all messages <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Radio, ArrowRight, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { formatCurrency, pnlColor, relativeTime, signalBorderColor } from '@/lib/format';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { EmptyState } from './empty-state';
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


export function SignalSheet() {
  const [searchParams] = useSearchParams();
  const channelId = searchParams.get('channel');
  const href = useScopedHref();
  const [open, setOpen] = useState(false);

  const { data: signals = [], isError } = useQuery({
    queryKey: ['signals', channelId],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('signalsOnly', '1');
      params.set('limit', '20');
      if (channelId) params.set('channel', channelId);
      return api<Signal[]>(`/signals?${params}`);
    },
    enabled: open,
    staleTime: 30_000,
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs font-normal px-2.5">
          <Radio className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="hidden sm:inline">Signals</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader className="px-4 py-3 border-b">
          <DialogTitle className="text-sm font-medium">Recent Signals</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto flex-1">
          {isError ? (
            <EmptyState title="Unable to load recent signals" hint="Check local API status and retry" className="py-16" />
          ) : signals.length === 0 ? (
            <EmptyState title="No signals yet" hint="Trader messages will appear here" className="py-16" />
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
                        <span className={`flex items-center gap-1 text-[10px] font-semibold tabular-nums ${pnlColor(t.pnl)}`}>
                          <CheckCircle2 className="h-3 w-3" />
                          {formatCurrency(t.pnl, 0)}
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
        </div>
        <div className="border-t px-4 py-3">
          <Link
            to={href('/messages')}
            onClick={() => setOpen(false)}
            className="flex items-center justify-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            View all messages <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}

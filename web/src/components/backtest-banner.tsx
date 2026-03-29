import { Link } from 'react-router-dom';
import { useChannelStore } from '@/stores/channel-store';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { pctDisplay } from '@src/lib/numbers';
import { Button } from '@/components/ui/button';
import { formatDateShort, formatCurrency, pnlColor } from '@/lib/format';

export function BacktestBanner() {
  const href = useScopedHref();
  const channelId = useChannelStore((s) => s.channelId);
  const defaultChannelId = useChannelStore((s) => s.defaultChannelId);
  const brief = useChannelStore((s) => s.channelBrief);
  const status = useChannelStore((s) => s.status);
  const selectChannel = useChannelStore((s) => s.selectChannel);

  if (status?.channelKind !== 'backtest' || !channelId || !brief) return null;

  const formatDateRange = (start: string, end: string) =>
    `${formatDateShort(start)}\u2013${formatDateShort(end)}`;

  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-info/20 bg-info/5 px-4 text-xs z-50">
      <Link
        to={href(`/backtests/${brief.id}`)}
        className="text-info font-semibold hover:text-info/80 whitespace-nowrap"
      >
        {brief.name || `Backtest #${brief.id}`}
      </Link>

      <span className="text-muted-foreground">&middot;</span>
      <span className="text-muted-foreground whitespace-nowrap">
        {formatDateRange(brief.startDate, brief.endDate)}
      </span>

      <span className="text-muted-foreground">&middot;</span>
      <span className="text-muted-foreground whitespace-nowrap">
        {brief.agentModel}
      </span>

      <span className="text-muted-foreground">&middot;</span>
      <span
        className={`font-semibold tabular-nums whitespace-nowrap ${pnlColor(brief.totalPnl)}`}
      >
        {brief.totalPnl >= 0 ? '+' : ''}
        {formatCurrency(brief.totalPnl, 0)} P&L
      </span>

      <span className="text-muted-foreground">&middot;</span>
      <span className="text-muted-foreground tabular-nums whitespace-nowrap">
        {pctDisplay(brief.winRate)} WR
      </span>

      <span className="text-muted-foreground">&middot;</span>
      <span className="text-muted-foreground tabular-nums whitespace-nowrap">
        {brief.totalTrades} trades
      </span>

      <div className="flex-1" />

      {defaultChannelId && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => selectChannel(defaultChannelId)}
          className="text-muted-foreground hover:text-foreground whitespace-nowrap"
        >
          &times; Exit Backtest
        </Button>
      )}
    </div>
  );
}

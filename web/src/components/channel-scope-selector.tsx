import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, FlaskConical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { useChannelStore } from '@/stores/channel-store';
import type { StatusData } from '@/stores/channel-store';
import { api } from '@/lib/api';

type HealthState = 'healthy' | 'degraded' | 'unknown';

function deriveHealthState(status: StatusData | null): HealthState {
  if (!status || status.channelKind !== 'runtime') return 'unknown';
  if (status.circuitOpen || status.brokerHealthy === false) return 'degraded';
  return 'healthy';
}

const healthDotColor: Record<HealthState, string> = {
  healthy: 'bg-profit',
  degraded: 'bg-loss',
  unknown: 'bg-muted-foreground',
};

function HealthDot({ state, className }: { state: HealthState; className?: string }) {
  return <span className={cn('inline-block h-2 w-2 rounded-full', healthDotColor[state], className)} />;
}

type RuntimeChannelItem = {
  id: string;
  kind: 'runtime';
  label: string;
  brokerName: string;
  mode: string;
  accountId: string;
};

type BacktestChannelItem = {
  id: string;
  kind: 'backtest';
  runId: string;
  label: string;
  status: string;
  traders: string[];
  startDate: string;
  endDate: string;
  totalPnl: number | null;
  winRate: number | null;
};

type ChannelsResponse = {
  defaultChannelId: string | null;
  runtimeChannels: RuntimeChannelItem[];
  backtestChannels: BacktestChannelItem[];
};

export function ChannelScopeSelector() {
  const channelId = useChannelStore((s) => s.channelId);
  const status = useChannelStore((s) => s.status);
  const channelBrief = useChannelStore((s) => s.channelBrief);
  const setDefaultChannelId = useChannelStore((s) => s.setDefaultChannelId);
  const selectChannel = useChannelStore((s) => s.selectChannel);

  const [open, setOpen] = useState(false);

  const { data: channelData, isLoading: loading } = useQuery({
    queryKey: ['channels'],
    queryFn: async () => {
      const data = await api<ChannelsResponse>('/channels');
      if (data.defaultChannelId) {
        setDefaultChannelId(data.defaultChannelId);
      }
      return data;
    },
    enabled: open,
    staleTime: Infinity,
  });

  const runtimeChannels = channelData?.runtimeChannels ?? [];
  const backtestChannels = channelData?.backtestChannels ?? [];

  function handleSelect(id: string) {
    setOpen(false);
    selectChannel(id);
  }

  function formatPnl(pnl: number | null): string {
    if (pnl == null) return '';
    const sign = pnl >= 0 ? '+' : '';
    return `${sign}$${pnl.toFixed(0)}`;
  }

  const healthState = deriveHealthState(status);

  const selectedRuntime = channelId
    ? runtimeChannels.find((c) => c.id === channelId) ?? null
    : null;
  const selectedBacktest = channelId
    ? backtestChannels.find((c) => c.id === channelId) ?? null
    : null;
  const isBacktestScope = status?.channelKind === 'backtest' || !!selectedBacktest;
  const displayId = channelId ?? 'Select channel';
  const displayMeta = isBacktestScope
    ? (channelBrief
      ? `${channelBrief.startDate} – ${channelBrief.endDate}`
      : selectedBacktest
        ? `${selectedBacktest.startDate} – ${selectedBacktest.endDate}`
        : null)
    : (selectedRuntime?.label ?? null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          role="combobox"
          aria-expanded={open}
          className="h-auto min-h-7 gap-2 text-xs font-normal px-2.5 py-1"
        >
          {isBacktestScope ? (
            <>
              <FlaskConical className="h-3.5 w-3.5 text-info shrink-0" />
              <div className="flex flex-col items-start leading-tight max-w-[200px]">
                <span className="text-info truncate w-full">
                  {displayId}
                </span>
                {displayMeta && (
                  <span className="text-[10px] text-muted-foreground truncate w-full">
                    {displayMeta}
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <HealthDot state={healthState} />
              <div className="flex flex-col items-start leading-tight max-w-[200px]">
                <span className="truncate w-full">{displayId}</span>
                {displayMeta && (
                  <span className="text-[10px] text-muted-foreground truncate w-full">
                    {displayMeta}
                  </span>
                )}
              </div>
            </>
          )}
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="end">
        <Command>
          <CommandInput placeholder="Search channels..." />
          <CommandList>
            <CommandEmpty>
              {loading ? 'Loading...' : 'No channels found.'}
            </CommandEmpty>
            {runtimeChannels.length > 0 && (
              <CommandGroup heading="Runtime Channels">
                {runtimeChannels.map((channel) => (
                  <CommandItem
                    key={channel.id}
                    value={`${channel.id} ${channel.label}`}
                    onSelect={() => handleSelect(channel.id)}
                  >
                    <HealthDot state={channel.id === channelId ? healthState : 'unknown'} className="mr-2" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{channel.id}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {channel.label}
                      </div>
                    </div>
                    <Check
                      className={cn(
                        'h-3 w-3 shrink-0',
                        channelId === channel.id ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {backtestChannels.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Backtest Runs">
                  {backtestChannels.map((channel) => {
                    return (
                      <CommandItem
                        key={channel.id}
                        value={`${channel.id} ${channel.label}`}
                        onSelect={() => handleSelect(channel.id)}
                      >
                        <FlaskConical className="h-3.5 w-3.5 text-info mr-2 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate">{channel.id}</div>
                          <div className="text-xs text-muted-foreground flex gap-2">
                            <span>{channel.startDate} &ndash; {channel.endDate}</span>
                            {channel.winRate != null && (
                              <span>{(channel.winRate * 100).toFixed(0)}% WR</span>
                            )}
                            {channel.totalPnl != null && (
                              <span
                                className={
                                  channel.totalPnl >= 0
                                    ? 'text-profit'
                                    : 'text-loss'
                                }
                              >
                                {formatPnl(channel.totalPnl)}
                              </span>
                            )}
                          </div>
                        </div>
                        <Check
                          className={cn(
                            'h-3 w-3 shrink-0',
                            channelId === channel.id ? 'opacity-100' : 'opacity-0',
                          )}
                        />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

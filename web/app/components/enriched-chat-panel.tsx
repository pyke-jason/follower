'use client';

import { useState, useMemo, useCallback, useTransition } from 'react';
import { ChatFeed } from '../messages/chat-feed';
import { EnrichedChatBubble } from './enriched-chat-bubble';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Check, Filter } from 'lucide-react';
import type { EnrichedMessage } from '../../../src/lib/enriched-message';
import { getMessageRole } from '../../../src/lib/enriched-message';
import type { Message } from '../../../src/db/schema';
import { fetchEnrichedMessages } from '../backtests/actions';

type FilterMode = 'all' | 'executed' | 'skipped';

const START_INDEX = 10_000;

export function EnrichedChatPanel({
  initialMessages,
  initialCursor,
  runId,
  traders,
  startDate,
  endDate,
  decisionSummary,
  scatterChart,
  isRunning,
  lastProcessedTs,
}: {
  initialMessages: EnrichedMessage[];
  initialCursor: string | null;
  runId?: string;
  traders: string[];
  startDate: string;
  endDate: string;
  decisionSummary: {
    executedCount: number;
    skippedCount: number;
    totalDecisions: number;
    skipReasonCounts: [string, number][];
  } | null;
  scatterChart?: React.ReactNode;
  isRunning?: boolean;
  lastProcessedTs?: string | null;
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [cursor, setCursor] = useState(initialCursor);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [selectedReasons, setSelectedReasons] = useState<string[]>([]);
  const [isLoading, startTransition] = useTransition();
  const [firstItemIndex, setFirstItemIndex] = useState(START_INDEX);

  // Build a lookup map from messageId → enrichment data
  const enrichmentMap = useMemo(() => {
    const map = new Map<string, EnrichedMessage>();
    for (const em of messages) {
      map.set(em.message.id, em);
    }
    return map;
  }, [messages]);

  // Client-side skip reason filtering (on top of server-side role filter)
  const visibleMessages = useMemo(() => {
    if (selectedReasons.length === 0) return messages;
    return messages.filter((m) => {
      if (!m.decision?.reasoning) return false;
      const reason = m.decision.reasoning.toLowerCase();
      return selectedReasons.some((r) => reason.includes(r.toLowerCase()));
    });
  }, [messages, selectedReasons]);

  const plainMessages = useMemo(() => visibleMessages.map((m) => m.message), [visibleMessages]);

  // Find the last message at or before the processing cursor (for scroll anchoring)
  const anchorMessageId = useMemo(() => {
    if (!isRunning || !lastProcessedTs) return undefined;
    // Messages are in DESC order; find the first one whose timestamp <= cutoff
    const found = visibleMessages.find((m) => m.message.timestamp <= lastProcessedTs);
    return found?.message.id;
  }, [isRunning, lastProcessedTs, visibleMessages]);

  // Server-side filter change: reload messages with new role filter
  const handleFilterChange = useCallback(
    (newFilter: FilterMode) => {
      setFilter(newFilter);
      setFirstItemIndex(START_INDEX);
      setSelectedReasons([]);

      startTransition(async () => {
        const result = await fetchEnrichedMessages(
          traders,
          startDate,
          endDate,
          undefined, // no cursor — fresh load
          runId,
          newFilter,
        );
        setMessages(result.rows);
        setCursor(result.nextCursor);
      });
    },
    [traders, startDate, endDate, runId],
  );

  const handleLoadOlder = useCallback(() => {
    if (!cursor || isLoading) return;
    startTransition(async () => {
      const result = await fetchEnrichedMessages(
        traders,
        startDate,
        endDate,
        cursor,
        runId,
        filter,
      );
      setMessages((prev) => [...prev, ...result.rows]);
      setCursor(result.nextCursor);
      setFirstItemIndex((prev) => prev - result.rows.length - 5);
    });
  }, [cursor, isLoading, traders, startDate, endDate, runId, filter]);

  const renderItem = useCallback(
    (message: Message, isHighlighted: boolean) => {
      const enriched = enrichmentMap.get(message.id);
      if (!enriched) return null;
      const isPending = !!(isRunning && lastProcessedTs && message.timestamp > lastProcessedTs);
      return (
        <EnrichedChatBubble
          enriched={enriched}
          runId={runId}
          isHighlighted={isHighlighted}
          isPending={isPending}
        />
      );
    },
    [enrichmentMap, runId, isRunning, lastProcessedTs],
  );

  const toggleReason = (reason: string) => {
    setSelectedReasons((prev) =>
      prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason],
    );
  };

  const skipReasons = decisionSummary?.skipReasonCounts ?? [];

  return (
    <div className="space-y-3">
      {/* Scatter chart (backtest only) */}
      {scatterChart}

      {/* Chat feed with filter bar */}
      <div className="rounded-lg border bg-card overflow-hidden flex flex-col" style={{ height: 'calc(100vh - 20rem)' }}>
        {/* Filter bar — same pattern as /messages ChatFilters */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-background/80 backdrop-blur-sm flex-wrap sticky top-0 z-10">
          {/* Decision filter */}
          <ToggleGroup
            type="single"
            value={filter}
            onValueChange={(v) => { if (v) handleFilterChange(v as FilterMode); }}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="all" className="text-xs">All</ToggleGroupItem>
            <ToggleGroupItem value="executed" className="text-xs">
              Executed{decisionSummary ? ` (${decisionSummary.executedCount})` : ''}
            </ToggleGroupItem>
            <ToggleGroupItem value="skipped" className="text-xs">
              Skipped{decisionSummary ? ` (${decisionSummary.skippedCount})` : ''}
            </ToggleGroupItem>
          </ToggleGroup>

          {/* Skip reason filter popover */}
          {skipReasons.length > 0 && (
            <>
              <div className="w-px h-5 bg-border" />
              <Popover>
                <PopoverTrigger asChild>
                  <button className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border text-muted-foreground hover:bg-accent transition-colors">
                    <Filter className="w-3.5 h-3.5" />
                    <span>Skip Reasons</span>
                    {selectedReasons.length > 0 && (
                      <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-secondary text-secondary-foreground text-[10px] leading-none font-medium">
                        {selectedReasons.length}
                      </span>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-0">
                  <div className="max-h-64 overflow-y-auto py-1">
                    {skipReasons.map(([reason, count]) => {
                      const isSelected = selectedReasons.includes(reason);
                      return (
                        <button
                          key={reason}
                          onClick={() => toggleReason(reason)}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-accent transition-colors"
                        >
                          <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center flex-shrink-0 ${
                            isSelected ? 'bg-primary border-primary' : 'border-border'
                          }`}>
                            {isSelected && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                          </div>
                          <span className="truncate text-muted-foreground">{reason}</span>
                          <span className="ml-auto text-muted-foreground/60 tabular-nums">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                  {selectedReasons.length > 0 && (
                    <div className="border-t border-border p-2">
                      <button
                        onClick={() => setSelectedReasons([])}
                        className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Clear all
                      </button>
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </>
          )}

          {/* Selected reason chips */}
          {selectedReasons.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {selectedReasons.slice(0, 2).map((reason) => (
                <button
                  key={reason}
                  onClick={() => toggleReason(reason)}
                  className="inline-flex items-center gap-1 text-[11px] pl-2 pr-1 py-0.5 rounded-full bg-secondary text-muted-foreground"
                >
                  {reason.length > 25 ? reason.slice(0, 22) + '...' : reason}
                  <span className="opacity-60 hover:opacity-100 ml-0.5">&times;</span>
                </button>
              ))}
              {selectedReasons.length > 2 && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                  +{selectedReasons.length - 2}
                </span>
              )}
            </div>
          )}
        </div>

        <ChatFeed
          messages={plainMessages}
          firstItemIndex={firstItemIndex}
          onLoadOlder={handleLoadOlder}
          isLoadingOlder={isLoading}
          hasMore={cursor !== null}
          renderItem={renderItem}
          focusMessageId={anchorMessageId}
          anchorMessageId={anchorMessageId}
        />
      </div>
    </div>
  );
}

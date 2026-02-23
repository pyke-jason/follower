'use client';

import { useState, useRef, useMemo, useCallback, useTransition, useEffect } from 'react';
import { ChatFilters } from './chat-filters';
import { ChatFeed } from './chat-feed';
import { RelatedMessagesPanel } from './related-messages-panel';
import { fetchMessages, fetchRelatedMessages, type MessageFilters, type MessageIntent, type MessageEnrichment } from './actions';
import type { Message, MessageLabel } from '../../../src/db/schema';

const START_INDEX = 100_000;

function buildMergedFilters(filters: MessageFilters, constraints: FilterConstraints | undefined): MessageFilters {
  return {
    ...filters,
    ...(constraints?.authors && { authors: constraints.authors }),
    ...(constraints?.startDate && { startDate: constraints.startDate }),
    ...(constraints?.endDate && { endDate: constraints.endDate }),
    ...(constraints?.runId && { runId: constraints.runId }),
  };
}

export type FilterConstraints = {
  authors?: string[];
  startDate?: string;
  endDate?: string;
  runId?: string;
  lastProcessedTs?: string;
};

type RelatedContext = {
  messages: Message[];
  intents: Record<string, MessageIntent>;
  labels: Record<string, MessageLabel>;
  sourceSymbols: string[];
};

export type StableDecisionCounts = {
  processedCount: number;
  executedCount: number;
  skippedCount: number;
};

export function ChatRoom({
  initialMessages,
  initialCursor,
  initialIntents,
  initialLabels,
  initialEnrichment,
  authors,
  constraints,
  stableDecisionCounts,
}: {
  initialMessages: Message[];
  initialCursor: string | null;
  initialIntents: Record<string, MessageIntent>;
  initialLabels: Record<string, MessageLabel>;
  initialEnrichment?: Record<string, MessageEnrichment>;
  authors: string[];
  constraints?: FilterConstraints;
  stableDecisionCounts?: StableDecisionCounts;
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [intents, setIntents] = useState(initialIntents);
  const [labels, setLabels] = useState(initialLabels);
  const [enrichment, setEnrichment] = useState<Record<string, MessageEnrichment>>(initialEnrichment ?? {});
  const [cursor, setCursor] = useState(initialCursor);
  const [firstItemIndex, setFirstItemIndex] = useState(START_INDEX);
  const [filters, setFilters] = useState<MessageFilters>({});
  const [isLoadingOlder, startLoadingTransition] = useTransition();

  // Split layout: selected message + related messages
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [relatedContext, setRelatedContext] = useState<RelatedContext | null>(null);
  const [isLoadingRelated, startRelatedTransition] = useTransition();

  // Merge constraints into filters for every fetch
  const mergedFilters = useMemo(() => buildMergedFilters(filters, constraints), [filters, constraints]);

  // Decision summary for filter bar badges.
  // Prefer stable counts from the server (full run totals) over the paginated enrichment subset.
  const decisionSummary = useMemo(() => {
    if (!constraints?.runId) return null;
    if (stableDecisionCounts) return stableDecisionCounts;
    // Fallback: derive from current enrichment page (counts will shift with filter changes)
    const entries = Object.values(enrichment);
    const executed = entries.filter((e) => e.trade).length;
    const skipped = entries.filter((e) => e.decision && !e.trade).length;
    return { processedCount: executed + skipped, executedCount: executed, skippedCount: skipped };
  }, [stableDecisionCounts, enrichment, constraints?.runId]);

  // Anchor to last processed message for live runs
  const anchorMessageId = useMemo(() => {
    if (!constraints?.lastProcessedTs) return undefined;
    const ts = constraints.lastProcessedTs;
    // Messages are in desc order in state; find first one at or before cutoff
    const found = messages.find((m) => m.timestamp <= ts);
    return found?.id;
  }, [constraints?.lastProcessedTs, messages]);

  // Refs to avoid stale closures in the effect below
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  // When the server passes fresh initialMessages (e.g. AutoRefresh on a running backtest),
  // merge new messages into state without blowing away older ones the user may have loaded.
  // Skip if user has applied client-side filters — initialMessages reflects server constraints
  // only and would pollute a filtered view.
  useEffect(() => {
    if (Object.keys(filtersRef.current).length > 0) return;
    const existingIds = new Set(messagesRef.current.map((m) => m.id));
    const incoming = initialMessages.filter((m) => !existingIds.has(m.id));
    if (!incoming.length) return;
    // State is desc (newest first); incoming messages are newer, so prepend.
    setMessages((prev) => [...incoming, ...prev]);
    setEnrichment((prev) => ({ ...prev, ...initialEnrichment }));
    setIntents((prev) => ({ ...prev, ...initialIntents }));
    setLabels((prev) => ({ ...prev, ...initialLabels }));
  }, [initialMessages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync filters to URL search params (skip when in constrained mode)
  useEffect(() => {
    if (constraints) return;
    const params = new URLSearchParams();
    if (filters.authors?.length) params.set('authors', filters.authors.join(','));
    if (filters.startDate) params.set('start', filters.startDate);
    if (filters.endDate) params.set('end', filters.endDate);
    if (filters.signalsOnly) params.set('signals', '1');
    if (filters.labelFilter) params.set('label', filters.labelFilter);

    const search = params.toString();
    const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;
    window.history.replaceState(null, '', url);
  }, [filters, constraints]);

  // When filters change, reset and reload
  const handleFilterChange = useCallback(
    (newFilters: MessageFilters) => {
      setFilters(newFilters);
      setFirstItemIndex(START_INDEX);

      const merged = buildMergedFilters(newFilters, constraints);

      startLoadingTransition(async () => {
        const result = await fetchMessages(merged);
        setMessages(result.messages);
        setIntents(result.intents);
        setLabels(result.labels);
        setEnrichment(result.enrichment);
        setCursor(result.nextCursor);
      });
    },
    [constraints]
  );

  // Load older messages (prepend)
  const handleLoadOlder = useCallback(() => {
    if (!cursor) return;

    startLoadingTransition(async () => {
      const result = await fetchMessages({ ...mergedFilters, cursor });
      if (result.messages.length === 0) {
        setCursor(null);
        return;
      }

      const newItemCount = result.messages.length + 5; // padding for date separators
      setFirstItemIndex((prev) => prev - newItemCount);
      setMessages((prev) => [...result.messages, ...prev]);
      setIntents((prev) => ({ ...prev, ...result.intents }));
      setLabels((prev) => ({ ...prev, ...result.labels }));
      setEnrichment((prev) => ({ ...prev, ...result.enrichment }));
      setCursor(result.nextCursor);
    });
  }, [cursor, mergedFilters]);

  // Handle message click → load related messages
  const handleMessageClick = useCallback((message: Message) => {
    if (selectedMessage?.id === message.id) {
      setSelectedMessage(null);
      setRelatedContext(null);
      return;
    }
    setSelectedMessage(message);
    setRelatedContext(null);

    startRelatedTransition(async () => {
      const result = await fetchRelatedMessages(message.id);
      setRelatedContext(result);
    });
  }, [selectedMessage?.id]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <ChatFilters
        authors={authors}
        filters={filters}
        onFilterChange={handleFilterChange}
        constraints={constraints}
        decisionSummary={decisionSummary}
      />
      <div className="flex flex-1 min-h-0 gap-0">
        <div className="flex-1 min-w-0 flex flex-col">
          <ChatFeed
            messages={messages}
            intents={intents}
            labels={labels}
            enrichment={Object.keys(enrichment).length > 0 ? enrichment : undefined}
            lastProcessedTs={constraints?.lastProcessedTs ?? undefined}
            runId={constraints?.runId}
            firstItemIndex={firstItemIndex}
            onLoadOlder={handleLoadOlder}
            isLoadingOlder={isLoadingOlder}
            hasMore={cursor !== null}
            selectedMessageId={selectedMessage?.id}
            onMessageClick={handleMessageClick}
            anchorMessageId={anchorMessageId}
            focusMessageId={anchorMessageId}
          />
        </div>
        {selectedMessage && (
          <RelatedMessagesPanel
            sourceMessage={selectedMessage}
            context={relatedContext}
            isLoading={isLoadingRelated}
            onClose={() => { setSelectedMessage(null); setRelatedContext(null); }}
          />
        )}
      </div>
    </div>
  );
}

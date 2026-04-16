import { create } from 'zustand';
import type { Message } from '@src/db/schema';
import type { TradeOutcome, MessageDecision } from '@src/lib/enriched-message';
import { api } from '@/lib/api';

export type LabelFilter = 'labeled' | 'unlabeled';

export type MessageEnrichment = {
  decision: MessageDecision | null;
  trade: TradeOutcome | null;
};

export type MessageFilters = {
  authors?: string[];
  startDate?: string;
  endDate?: string;
  signalsOnly?: boolean;
  labelFilter?: LabelFilter;
  cursor?: string;
  channelId?: string;
  roleFilter?: 'all' | 'processed' | 'executed' | 'skipped';
};

const PAGE_SIZE = 50;
const START_INDEX = 100_000;

export type FilterConstraints = {
  authors?: string[];
  startDate?: string;
  endDate?: string;
  channelId?: string;
  lastProcessedTs?: string;
};

export type RelatedContext = {
  messages: Message[];
  sourceSymbols: string[];
};

export type StableDecisionCounts = {
  processedCount: number;
  executedCount: number;
  skippedCount: number;
};

export type ChatHydration = {
  messages: Message[];
  nextCursor: string | null;
  enrichment: Record<string, MessageEnrichment> | null;
  authors: string[];
  constraints?: FilterConstraints;
  stableDecisionCounts?: StableDecisionCounts;
};

function buildMergedFilters(
  filters: MessageFilters,
  constraints: FilterConstraints | undefined,
): MessageFilters {
  return {
    ...filters,
    ...(constraints?.authors && { authors: constraints.authors }),
    ...(constraints?.startDate && { startDate: constraints.startDate }),
    ...(constraints?.endDate && { endDate: constraints.endDate }),
    ...(constraints?.channelId && { channelId: constraints.channelId }),
  };
}

function buildMessageParams(filters: MessageFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.authors?.length) params.set('authors', filters.authors.join(','));
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  if (filters.signalsOnly) params.set('signalsOnly', 'true');
  if (filters.labelFilter) params.set('labelFilter', filters.labelFilter);
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (filters.channelId) params.set('channel', filters.channelId);
  if (filters.roleFilter) params.set('roleFilter', filters.roleFilter);
  params.set('limit', String(PAGE_SIZE + 1));
  return params;
}

interface ChatState {
  messages: Message[];
  enrichment: Record<string, MessageEnrichment> | null;
  cursor: string | null;
  firstItemIndex: number;
  filters: MessageFilters;
  authors: string[];
  constraints: FilterConstraints | undefined;
  stableDecisionCounts: StableDecisionCounts | undefined;

  selectedMessage: Message | null;
  relatedContext: RelatedContext | null;
  isLoadingOlder: boolean;
  isLoadingRelated: boolean;

  hydrate: (data: ChatHydration) => void;
  mergeNewMessages: (
    msgs: Message[],
    newEnrichment: Record<string, MessageEnrichment> | null,
  ) => void;
  setFilters: (filters: MessageFilters) => void;
  loadOlderMessages: () => Promise<void>;
  selectMessage: (msg: Message | null) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  enrichment: null,
  cursor: null,
  firstItemIndex: START_INDEX,
  filters: {},
  authors: [],
  constraints: undefined,
  stableDecisionCounts: undefined,

  selectedMessage: null,
  relatedContext: null,
  isLoadingOlder: false,
  isLoadingRelated: false,

  hydrate: (data) =>
    set({
      messages: data.messages,
      enrichment: data.enrichment,
      cursor: data.nextCursor,
      authors: data.authors,
      constraints: data.constraints,
      stableDecisionCounts: data.stableDecisionCounts,
      firstItemIndex: START_INDEX,
      filters: {},
      selectedMessage: null,
      relatedContext: null,
      isLoadingOlder: false,
      isLoadingRelated: false,
    }),

  mergeNewMessages: (newMsgs, newEnrichment) => {
    const { filters, messages } = get();
    if (Object.keys(filters).length > 0) return;
    const existingIds = new Set(messages.map((m) => m.id));
    const incoming = newMsgs.filter((m) => !existingIds.has(m.id));
    if (!incoming.length) return;
    set((state) => ({
      messages: [...incoming, ...state.messages],
      enrichment: newEnrichment ? { ...state.enrichment, ...newEnrichment } : state.enrichment,
    }));
  },

  setFilters: async (newFilters) => {
    const { constraints } = get();
    set({ filters: newFilters, firstItemIndex: START_INDEX, isLoadingOlder: true });

    const merged = buildMergedFilters(newFilters, constraints);
    const params = buildMessageParams(merged);
    const result = await api<ChatHydration>(`/messages?${params}`);
    set({
      messages: result.messages,
      enrichment: result.enrichment,
      cursor: result.nextCursor,
      isLoadingOlder: false,
    });
  },

  loadOlderMessages: async () => {
    const { cursor, filters, constraints } = get();
    if (!cursor) return;

    set({ isLoadingOlder: true });
    const merged = buildMergedFilters(filters, constraints);
    const params = buildMessageParams({ ...merged, cursor });
    const result = await api<ChatHydration>(`/messages?${params}`);

    if (result.messages.length === 0) {
      set({ cursor: null, isLoadingOlder: false });
      return;
    }

    const newItemCount = result.messages.length + 5;
    set((state) => ({
      firstItemIndex: state.firstItemIndex - newItemCount,
      messages: [...state.messages, ...result.messages],
      enrichment: result.enrichment ? { ...state.enrichment, ...result.enrichment } : state.enrichment,
      cursor: result.nextCursor,
      isLoadingOlder: false,
    }));
  },

  selectMessage: async (msg) => {
    const { selectedMessage } = get();
    if (!msg || selectedMessage?.id === msg.id) {
      set({ selectedMessage: null, relatedContext: null });
      return;
    }
    set({ selectedMessage: msg, relatedContext: null, isLoadingRelated: true });
    const result = await api<RelatedContext>(`/messages/${msg.id}/related`);
    if (get().selectedMessage?.id === msg.id) {
      set({ relatedContext: result, isLoadingRelated: false });
    }
  },
}));

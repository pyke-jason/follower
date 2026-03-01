import { create } from 'zustand';
import type { Message, MessageLabel } from '@src/db/schema';
import {
  fetchMessages,
  fetchRelatedMessages,
  type MessageFilters,
  type MessageEnrichment,
} from '@/app/messages/actions';

const START_INDEX = 100_000;

export type FilterConstraints = {
  authors?: string[];
  startDate?: string;
  endDate?: string;
  runId?: string;
  lastProcessedTs?: string;
};

export type RelatedContext = {
  messages: Message[];
  labels: Record<string, MessageLabel>;
  sourceSymbols: string[];
};

export type StableDecisionCounts = {
  processedCount: number;
  executedCount: number;
  skippedCount: number;
};

export type ChatHydration = {
  messages: Message[];
  cursor: string | null;
  labels: Record<string, MessageLabel>;
  enrichment: Record<string, MessageEnrichment>;
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
    ...(constraints?.runId && { runId: constraints.runId }),
  };
}

interface ChatState {
  messages: Message[];
  labels: Record<string, MessageLabel>;
  enrichment: Record<string, MessageEnrichment>;
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
    newLabels: Record<string, MessageLabel>,
    newEnrichment: Record<string, MessageEnrichment>,
  ) => void;
  setFilters: (filters: MessageFilters) => void;
  loadOlderMessages: () => Promise<void>;
  selectMessage: (msg: Message | null) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  labels: {},
  enrichment: {},
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
      labels: data.labels,
      enrichment: data.enrichment,
      cursor: data.cursor,
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

  mergeNewMessages: (newMsgs, newLabels, newEnrichment) => {
    const { filters, messages } = get();
    if (Object.keys(filters).length > 0) return;
    const existingIds = new Set(messages.map((m) => m.id));
    const incoming = newMsgs.filter((m) => !existingIds.has(m.id));
    if (!incoming.length) return;
    set((state) => ({
      messages: [...incoming, ...state.messages],
      labels: { ...state.labels, ...newLabels },
      enrichment: { ...state.enrichment, ...newEnrichment },
    }));
  },

  setFilters: async (newFilters) => {
    const { constraints } = get();
    set({ filters: newFilters, firstItemIndex: START_INDEX, isLoadingOlder: true });

    const merged = buildMergedFilters(newFilters, constraints);
    const result = await fetchMessages(merged);
    set({
      messages: result.messages,
      labels: result.labels,
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
    const result = await fetchMessages({ ...merged, cursor });

    if (result.messages.length === 0) {
      set({ cursor: null, isLoadingOlder: false });
      return;
    }

    const newItemCount = result.messages.length + 5;
    set((state) => ({
      firstItemIndex: state.firstItemIndex - newItemCount,
      messages: [...result.messages, ...state.messages],
      labels: { ...state.labels, ...result.labels },
      enrichment: { ...state.enrichment, ...result.enrichment },
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
    const result = await fetchRelatedMessages(msg.id);
    if (get().selectedMessage?.id === msg.id) {
      set({ relatedContext: result, isLoadingRelated: false });
    }
  },
}));

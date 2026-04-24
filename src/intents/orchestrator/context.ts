import type { Message } from '@/db/schema.js';
import { formatChatContext, getRecentChatMessages } from '../trader-context.js';
import type { ChatHistoryProvider, OrchestratorContext, OrchestratorEnv } from './types.js';

function createDbChatHistoryProvider(message: Message): ChatHistoryProvider {
  return {
    getRecentMessages: async (author?: string, limit?: number) => {
      const msgs = await getRecentChatMessages(message.timestamp, author, limit);
      return formatChatContext(msgs);
    },
  };
}

export async function buildOrchestratorContext(
  message: Message,
  env: OrchestratorEnv,
  failureContext?: { error: string },
): Promise<OrchestratorContext> {
  return {
    message,
    marketData: {
      getQuote: (s) => env.broker.getQuote(s),
      getOptionChain: async () => null,
      getExpiryDates: async () => [],
    },
    positions: {
      getPositions: env.getPositions,
    },
    chatHistory: env.chatHistory ?? createDbChatHistoryProvider(message),
    failureContext,
  };
}

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Message, Task } from '@/db/schema.js';
import type { OrchestratorResult } from '@/intents/orchestrator/types.js';
import type { ResolvedPipelineDeps } from './execute-resolved.js';

const executeResolvedSignalsMock = vi.hoisted(() => vi.fn());
const resolveOrchestratorMock = vi.hoisted(() => vi.fn());
const emitted = vi.hoisted(() => [] as Array<{ event: string; columns: Record<string, unknown>; snapshot?: Record<string, unknown> }>);

vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({})) }));

vi.mock('../db/client.js', () => {
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(async () => undefined),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [testMessage]),
        })),
      })),
    })),
  };
  const schema = {
    tasks: { id: {} },
    messages: { id: {} },
    trades: { metadata: {}, id: {} },
  };
  return { db, schema };
});

vi.mock('../intents/orchestrator/index.js', () => ({
  resolveOrchestrator: resolveOrchestratorMock,
}));

vi.mock('./execute-resolved.js', () => ({
  executeResolvedSignals: executeResolvedSignalsMock,
}));

vi.mock('../decisions/emitter.js', () => ({
  createEmitter: (scope: { channelId: string; taskId?: string; messageId?: string; onDecision?: (decision: Record<string, unknown>) => void }) => ({
    emit: async (event: string, columns: Record<string, unknown> = {}, snapshot?: Record<string, unknown>) => {
      emitted.push({ event, columns, snapshot });
      if (event === 'SETTLED') {
        scope.onDecision?.({
          id: `decision-${emitted.length}`,
          event,
          channelId: scope.channelId,
          taskId: scope.taskId,
          messageId: scope.messageId,
          ...columns,
          snapshot: snapshot ?? null,
        });
      }
    },
  }),
}));

vi.mock('../trades/trade-flags.js', () => ({
  stampHasUpdate: vi.fn(async () => undefined),
}));

vi.mock('../safety/classification-audit.js', () => ({
  enqueueClassificationAudit: vi.fn(),
}));

const testMessage: Message = {
  id: 'msg-1',
  author: 'Trader',
  timestamp: '2026-04-26T14:00:00.000Z',
  rawHtml: 'AAPL 200 calls for 1.20',
  cleanText: 'AAPL 200 calls for 1.20',
  badges: [],
  symbols: ['AAPL'],
  actionHint: null,
  directionHint: null,
  detectedStrategies: [],
  isPaperTrade: false,
  confidence: null,
  ingestedAt: '2026-04-26T14:00:00.000Z',
  contentHash: null,
  reactions: [],
};

const task: Task = {
  id: 'task-1',
  messageId: 'msg-1',
  taskType: 'EXECUTE_TRADE',
  status: 'PENDING',
  assignee: 'agent',
  priority: 0,
  context: { author: 'Trader', symbols: ['AAPL'] },
  createdAt: '2026-04-26T14:00:00.000Z',
  startedAt: null,
  completedAt: null,
  error: null,
  modelProvider: null,
  modelName: null,
  channelId: 'ibkr:paper:test',
};

const resolvedStockForOptionText: Extract<OrchestratorResult, { outcome: 'EXECUTE' }> = {
  outcome: 'EXECUTE',
  classifierSignals: [{
    action: 'OPEN',
    symbol: 'AAPL',
    direction: 'LONG',
    strategy: 'STOCK',
    strikes: null,
    expiry: null,
    statedPrice: 1.2,
    quantity: null,
  }],
  signals: [{
    orderType: 'STOCK',
    action: 'OPEN',
    limitPrice: 1.2,
    legs: [{ type: 'stock', symbol: 'AAPL', side: 'BUY', quantity: 1 }],
  }],
};

function makePipeline(sendAlert = vi.fn()): ResolvedPipelineDeps {
  return {
    broker: {} as ResolvedPipelineDeps['broker'],
    marketGuard: {} as ResolvedPipelineDeps['marketGuard'],
    recordTrade: vi.fn(),
    onPending: vi.fn(),
    sendAlert,
  } as unknown as ResolvedPipelineDeps;
}

describe('processTask safety gate', () => {
  beforeEach(() => {
    emitted.length = 0;
    executeResolvedSignalsMock.mockReset();
    resolveOrchestratorMock.mockReset();
    process.env.SAFETY_GATE_MODE = 'block';
  });

  test('blocked deterministic gate findings prevent broker execution', async () => {
    resolveOrchestratorMock.mockResolvedValue(resolvedStockForOptionText);
    const sendAlert = vi.fn();
    const onResult = vi.fn();
    const { processTask } = await import('./process-task.js');

    await processTask(task, {
      getOpenPositions: vi.fn(async () => []),
      agent: { identity: { provider: 'anthropic', model: 'claude-opus-4-7' } } as never,
      pipeline: makePipeline(sendAlert),
      scope: 'ibkr:paper:test',
      agentIdentity: { provider: 'anthropic', model: 'claude-opus-4-7' },
      onResult,
    });

    expect(executeResolvedSignalsMock).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'SETTLED',
      columns: expect.objectContaining({
        outcome: 'SKIP',
        phase: 'safety_gate',
        skipCategory: 'safety_block',
      }),
    }));
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'SKIP' }),
      expect.anything(),
    );
  });
});

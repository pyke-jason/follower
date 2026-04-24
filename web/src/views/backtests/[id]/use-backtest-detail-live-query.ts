import { useCallback, useEffect, useMemo } from 'react';
import { replaceEqualDeep, useQueryClient } from '@tanstack/react-query';
import { toApiUrl } from '@/lib/api';
import { queries } from '@/lib/queries';
import {
  BacktestLiveUpdateSchema,
  BacktestTradeSnapshotSchema,
  type BacktestDetailResponse,
  type BacktestLiveUpdate,
  type BacktestTradeSnapshot,
  type TradeLabel,
} from '@src/local-api/http-schemas';

const ACTIVE_STATUSES = new Set(['RUNNING', 'PENDING', 'PAUSED']);
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

type BacktestEventStreamOptions<TPayload extends object> = {
  runId: string;
  status: string;
  path: string;
  parse: (raw: string) => TPayload;
  onMessage: (payload: TPayload) => void;
  onTerminal?: () => void;
};

export function useBacktestDetailLiveQuery(
  runId: string,
  data: BacktestDetailResponse,
) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => queries.backtests.detail(runId).queryKey, [runId]);

  const applyRunUpdate = useCallback((update: BacktestLiveUpdate) => {
    queryClient.setQueryData<BacktestDetailResponse>(queryKey, (current) => {
      if (!current || current.run.id !== update.id) return current;
      return replaceEqualDeep(current, {
        ...current,
        run: {
          ...current.run,
          status: update.status,
          startedAt: update.startedAt,
          completedAt: update.completedAt,
          error: update.error,
          summary: update.summary ?? current.run.summary,
          liveMetrics: update.liveMetrics,
        },
        messagesEndDate: update.messagesEndDate,
        liveRuntime: update.liveRuntime,
      });
    });
  }, [queryClient, queryKey]);

  const applyTradeSnapshot = useCallback((snapshot: BacktestTradeSnapshot) => {
    queryClient.setQueryData<BacktestDetailResponse>(queryKey, (current) => {
      if (!current) return current;
      return replaceEqualDeep(current, {
        ...current,
        allTrades: snapshot.allTrades,
        eventsByTradeId: snapshot.eventsByTradeId,
        flagsByTradeId: snapshot.flagsByTradeId,
        labelsByTradeId: snapshot.labelsByTradeId,
        mtmSnapshots: snapshot.mtmSnapshots,
        summary: snapshot.summary,
        byTrader: snapshot.byTrader,
        byStrategy: snapshot.byStrategy,
        equityCurve: snapshot.equityCurve,
        tradeScatter: snapshot.tradeScatter,
        rollingWinRate: snapshot.rollingWinRate,
        strategyEquity: snapshot.strategyEquity,
        strategies: snapshot.strategies,
        llmCost: snapshot.llmCost,
        messagesEndDate: snapshot.messagesEndDate,
        evalSummary: snapshot.evalSummary,
      });
    });
  }, [queryClient, queryKey]);

  useBacktestEventStream({
    runId,
    status: data.run.status,
    path: `/backtests/${runId}/events`,
    parse: parseLiveUpdate,
    onMessage: applyRunUpdate,
    onTerminal: useCallback(() => {
      void queryClient.invalidateQueries({ queryKey });
    }, [queryClient, queryKey]),
  });

  useBacktestEventStream({
    runId,
    status: data.run.status,
    path: `/backtests/${runId}/trades/events`,
    parse: parseTradeSnapshot,
    onMessage: applyTradeSnapshot,
  });

  return useCallback((tradeId: string, patch: Partial<TradeLabel>) => {
    queryClient.setQueryData<BacktestDetailResponse>(queryKey, (current) => {
      const currentLabel = current?.labelsByTradeId?.[tradeId];
      if (!current || !currentLabel) return current;
      return replaceEqualDeep(current, {
        ...current,
        labelsByTradeId: {
          ...current.labelsByTradeId,
          [tradeId]: { ...currentLabel, ...patch },
        },
      });
    });
  }, [queryClient, queryKey]);
}

function useBacktestEventStream<TPayload extends object>({
  runId,
  status,
  path,
  parse,
  onMessage,
  onTerminal,
}: BacktestEventStreamOptions<TPayload>) {
  useEffect(() => {
    if (!ACTIVE_STATUSES.has(status)) return;

    const source = new EventSource(toApiUrl(path));
    source.onmessage = (event) => {
      const payload = parse(event.data);
      onMessage(payload);

      const terminalStatus = getTerminalStatus(payload);
      if (terminalStatus) {
        source.close();
        onTerminal?.();
      }
    };
    source.onerror = () => {
      source.close();
    };

    return () => {
      source.close();
    };
  }, [onMessage, onTerminal, parse, path, runId, status]);
}

function parseLiveUpdate(raw: string) {
  return BacktestLiveUpdateSchema.parse(JSON.parse(raw));
}

function parseTradeSnapshot(raw: string) {
  return BacktestTradeSnapshotSchema.parse(JSON.parse(raw));
}

function getTerminalStatus(payload: object) {
  const status = 'status' in payload ? payload.status : undefined;
  return typeof status === 'string' && TERMINAL_STATUSES.has(status) ? status : null;
}

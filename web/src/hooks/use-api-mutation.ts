import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { QueryKey, UseMutationResult } from '@tanstack/react-query';

type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Options<TVar, TRes> {
  /** Query keys to invalidate on success. */
  invalidate?: QueryKey[];
  /** Extract the JSON body from vars. When omitted: static path sends vars as body, function path sends no body. */
  body?: (vars: TVar) => unknown;
  /** Runs before the request — use for optimistic updates. */
  onMutate?: (vars: TVar) => void;
  /** Runs after invalidation. */
  onSuccess?: (data: TRes, vars: TVar) => void;
  onError?: (err: Error, vars: TVar) => void;
}

/**
 * Wrapper around useMutation + api() that handles JSON serialization
 * and query invalidation.
 *
 *   // fire-and-forget, no body
 *   const cancel = useApiMutation('POST', `/backtests/${id}/cancel`, {
 *     invalidate: [['backtest', id]],
 *   });
 *
 *   // typed JSON body
 *   const save = useApiMutation<{ key: string; value: string }>('POST', '/secrets', {
 *     invalidate: [['secrets']],
 *   });
 *   save.mutate({ key: 'FOO', value: 'bar' });
 *
 *   // dynamic path, no body
 *   const exit = useApiMutation('POST', (tradeId: string) => `/trades/${tradeId}/exit`, {
 *     invalidate: [['trades-open']],
 *   });
 *
 *   // dynamic path + partial body
 *   const resolve = useApiMutation<{ alertId: string; reason: string }>(
 *     'POST',
 *     (v) => `/reconciliation/${v.alertId}/resolve`,
 *     { body: (v) => ({ reason: v.reason }), invalidate: [['alerts']] },
 *   );
 *
 *   // optimistic update
 *   const toggle = useApiMutation<boolean>('POST', `/toggles/${id}`, {
 *     body: (checked) => ({ enabled: checked }),
 *     onMutate: (checked) => setOptimistic(checked),
 *     onError: () => setOptimistic(prev),
 *     invalidate: [['toggles']],
 *   });
 */
export function useApiMutation<TVar = void, TRes = unknown>(
  method: Method,
  path: string | ((vars: TVar) => string),
  opts?: Options<TVar, TRes>,
): UseMutationResult<TRes, Error, TVar> {
  const qc = useQueryClient();
  const pathIsFn = typeof path === 'function';

  return useMutation<TRes, Error, TVar>({
    mutationFn: (vars) => {
      const url = pathIsFn ? path(vars) : path;
      const payload = opts?.body ? opts.body(vars) : pathIsFn ? undefined : vars;
      const body = payload != null ? JSON.stringify(payload) : undefined;
      return api<TRes>(url, { method, ...(body !== undefined && { body }) });
    },
    onMutate: opts?.onMutate,
    onSuccess: (data, vars) => {
      if (opts?.invalidate) {
        for (const key of opts.invalidate) qc.invalidateQueries({ queryKey: key });
      }
      opts?.onSuccess?.(data, vars);
    },
    onError: opts?.onError,
  });
}

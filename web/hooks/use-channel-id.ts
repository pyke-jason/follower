import { useSearchParams } from 'react-router-dom';

/** Read the `?channel=` search param. Returns undefined when absent. */
export function useChannelId(): string | undefined {
  const [params] = useSearchParams();
  return params.get('channel') ?? undefined;
}

import { useSearchParams } from 'react-router-dom';
import { useScopedHref } from './use-scoped-href';

/**
 * Reads `?from=` to determine back-navigation target.
 * Falls back to `defaultPath` when `from` is absent or invalid.
 *
 *   const backHref = useBackHref('/trades');
 *   <Link to={backHref}><ArrowLeft /></Link>
 *
 * See docs/rails/back-navigation.md for the full pattern.
 */
export function useBackHref(defaultPath: string): string {
  const [params] = useSearchParams();
  const href = useScopedHref();
  const from = params.get('from');
  const target = from && from.startsWith('/') ? from : defaultPath;
  return href(target);
}

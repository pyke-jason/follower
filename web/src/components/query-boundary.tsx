import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Wraps query-dependent UI with loading and error states.
 *
 * Loading: renders the `skeleton` prop if provided, otherwise a minimal placeholder.
 * Each page should pass a skeleton that mirrors its actual content layout.
 *
 * Error: renders an error card with retry button.
 *
 * Data: renders children with a fade-in transition.
 */
export function QueryBoundary<T>({
  query,
  children,
  skeleton,
}: {
  query: {
    data: T | undefined;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    refetch: () => void;
  };
  children: (data: T) => ReactNode;
  /** Skeleton that mirrors the shape of the actual content. */
  skeleton?: ReactNode;
}) {
  if (query.isLoading && !query.data) {
    return <div className="animate-in-up">{skeleton ?? <MinimalSkeleton />}</div>;
  }

  if (query.isError) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-6 text-center animate-in-up">
        <p className="text-sm text-destructive">
          {query.error?.message ?? 'Something went wrong'}
        </p>
        <Button variant="outline" size="sm" onClick={() => query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (query.data !== undefined) {
    return <>{children(query.data)}</>;
  }

  return null;
}

function MinimalSkeleton() {
  return (
    <div className="space-y-3 py-8">
      <Skeleton className="h-4 w-48 mx-auto" />
      <Skeleton className="h-4 w-32 mx-auto" />
    </div>
  );
}

// ── Reusable skeleton building blocks ────────────────────────
// Pages compose these to build skeletons that match their real layout.

/** Skeleton that mirrors a MetricStrip with N cards */
export function MetricStripSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className={`grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-${count}`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-md border border-border/60 bg-card px-4 py-3 space-y-2">
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="h-5 w-20" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton that mirrors a card with a chart inside */
export function ChartCardSkeleton({ height = 180 }: { height?: number }) {
  return (
    <div className="rounded-md border bg-card p-0 overflow-hidden">
      <div className="px-4 py-3 border-b">
        <Skeleton className="h-2.5 w-20" />
      </div>
      <div className="p-4">
        <Skeleton className="w-full" style={{ height }} />
      </div>
    </div>
  );
}

/** Skeleton that mirrors a data table with header + rows */
export function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="rounded-md border bg-card overflow-hidden">
      <div className="flex items-center gap-6 px-4 py-3 border-b">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3" style={{ width: `${60 + (i % 3) * 20}px` }} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-6 px-4 py-3 border-b border-border/30">
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton key={j} className="h-4" style={{ width: `${50 + ((i + j) % 4) * 15}px` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Skeleton that mirrors a list of items (positions, signals) */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="rounded-md border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b">
        <Skeleton className="h-2.5 w-24" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-border/30">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-20 ml-auto" />
        </div>
      ))}
    </div>
  );
}

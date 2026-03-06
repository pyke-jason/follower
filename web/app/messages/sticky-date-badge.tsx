import { formatDayHeader } from '@/lib/format';

export function StickyDateBadge({ date }: { date: string | null }) {
  if (!date) return null;

  return (
    <div className="pointer-events-none absolute top-0 left-0 right-0 z-10 flex justify-center pt-2">
      <span className="pointer-events-auto rounded-full bg-muted/90 backdrop-blur-sm border border-border/50 px-3 py-1 text-xs text-muted-foreground shadow-sm">
        {formatDayHeader(date)}
      </span>
    </div>
  );
}

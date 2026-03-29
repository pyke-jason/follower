import { Separator } from '@/components/ui/separator';
import { formatDayHeader } from '@/lib/format';

export function DateSeparator({ date }: { date: string }) {
  return (
    <div className="flex items-center gap-3 py-3 px-4">
      <Separator className="flex-1" />
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {formatDayHeader(date)}
      </span>
      <Separator className="flex-1" />
    </div>
  );
}

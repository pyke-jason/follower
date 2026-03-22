import { cn } from '@/lib/utils';

interface EmptyStateProps {
  title: string;
  hint?: string;
  className?: string;
}

export function EmptyState({ title, hint, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-10 text-muted-foreground', className)}>
      <div className="h-8 w-8 rounded-full border-2 border-dashed border-muted-foreground/20 mb-3" />
      <p className="text-sm">{title}</p>
      {hint && <p className="text-xs mt-1 opacity-50">{hint}</p>}
    </div>
  );
}

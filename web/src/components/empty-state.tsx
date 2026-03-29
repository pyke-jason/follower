import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
  variant?: 'default' | 'filtered' | 'error';
  className?: string;
}

const variantStyles: Record<NonNullable<EmptyStateProps['variant']>, string> = {
  default: 'border-dashed border-muted-foreground/15',
  filtered: 'border-dashed border-muted-foreground/15',
  error: 'border-dashed border-destructive/25',
};

export function EmptyState({ title, hint, icon, action, variant = 'default', className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-10 text-muted-foreground', className)}>
      {icon ? (
        <div className={cn('mb-3', variant === 'error' && 'text-destructive/60')}>{icon}</div>
      ) : (
        <div className={cn('h-8 w-8 rounded-md border-2 mb-3', variantStyles[variant])} />
      )}
      <p className={cn('text-sm', variant === 'error' && 'text-destructive')}>{title}</p>
      {hint && <p className="text-xs font-mono mt-1 opacity-40">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

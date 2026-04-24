import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function DetailPanel({
  title,
  description,
  eyebrow,
  action,
  className,
  contentClassName,
  children,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  action?: ReactNode;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'border-t border-border/70 pt-4',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 pb-3">
        <div className="space-y-1">
          {eyebrow && (
            <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              {eyebrow}
            </span>
          )}
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description && (
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      <div className={cn(contentClassName)}>{children}</div>
    </section>
  );
}

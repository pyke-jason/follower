import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
    <Card
      className={cn(
        'gap-0 overflow-hidden rounded-[28px] border-border/70 bg-gradient-to-br from-card via-card to-muted/30 py-0 shadow-sm',
        className,
      )}
    >
      <CardHeader className="gap-3 border-b border-border/60 px-5 py-4">
        {eyebrow && (
          <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            {eyebrow}
          </span>
        )}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-base tracking-tight">{title}</CardTitle>
            {description && (
              <CardDescription className="max-w-2xl text-sm leading-relaxed">
                {description}
              </CardDescription>
            )}
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent className={cn('px-5 py-5', contentClassName)}>{children}</CardContent>
    </Card>
  );
}

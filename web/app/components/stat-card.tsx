import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function StatCard({
  label,
  value,
  color = 'text-foreground',
  icon: Icon,
  trend,
}: {
  label: string;
  value: string | number;
  color?: string;
  icon?: LucideIcon;
  trend?: string;
}) {
  return (
    <Card className="py-4 gap-1 border-border/50">
      <CardContent>
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
          {Icon && <Icon className="size-4 text-muted-foreground" />}
        </div>
        <p className={cn('text-xl font-semibold mt-1 tabular-nums', color)}>{value}</p>
        {trend && (
          <p className="text-xs text-muted-foreground mt-1">{trend}</p>
        )}
      </CardContent>
    </Card>
  );
}

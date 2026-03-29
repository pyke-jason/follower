import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface InfoChipProps {
  label: string;
  icon?: LucideIcon;
  onClick?: () => void;
  className?: string;
  href?: string;
}

export function InfoChip({ label, icon: Icon, onClick, className, href }: InfoChipProps) {
  const classes = cn(
    'inline-flex items-center gap-1 rounded px-1.5 py-0.5',
    'text-[10px] font-medium text-muted-foreground bg-muted/40',
    'border border-border/30 border-dashed',
    (onClick || href) && 'cursor-pointer hover:text-foreground hover:bg-muted/60 transition-colors',
    className
  );

  if (href) {
    return (
      <a href={href} className={classes}>
        {Icon && <Icon className="h-2.5 w-2.5" />}
        {label}
      </a>
    );
  }

  const Tag = onClick ? 'button' : 'span';

  return (
    <Tag className={classes} onClick={onClick}>
      {Icon && <Icon className="h-2.5 w-2.5" />}
      {label}
    </Tag>
  );
}

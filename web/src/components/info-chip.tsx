import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface InfoChipProps {
  label: string;
  icon?: LucideIcon;
  onClick?: () => void;
  className?: string;
  href?: string;
}

const chipBase = cn(
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5',
  'text-[10px] font-medium text-muted-foreground bg-muted/40',
  'border border-border/30 border-dashed',
);

const interactive = 'cursor-pointer hover:text-foreground hover:bg-muted/60 transition-colors';

export function InfoChip({ label, icon: Icon, onClick, className, href }: InfoChipProps) {
  if (href) {
    return (
      <Button variant="link" size="xs" asChild className={cn(chipBase, interactive, 'no-underline hover:no-underline', className)}>
        <Link to={href}>
          {Icon && <Icon className="h-2.5 w-2.5" />}
          {label}
        </Link>
      </Button>
    );
  }

  if (onClick) {
    return (
      <Button
        variant="ghost"
        size="xs"
        onClick={onClick}
        className={cn(chipBase, interactive, className)}
      >
        {Icon && <Icon className="h-2.5 w-2.5" />}
        {label}
      </Button>
    );
  }

  return (
    <span className={cn(chipBase, className)}>
      {Icon && <Icon className="h-2.5 w-2.5" />}
      {label}
    </span>
  );
}

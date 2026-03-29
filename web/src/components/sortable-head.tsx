import { TableHead } from '@/components/ui/table';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export function SortableHead<T extends string>({
  column,
  label,
  sort,
  onSort,
  align,
  className,
}: {
  column: T;
  label: string;
  sort: { column: T; dir: 'asc' | 'desc' };
  onSort: (column: T) => void;
  align?: 'left' | 'right';
  className?: string;
}) {
  const isActive = sort.column === column;

  const Icon = isActive
    ? sort.dir === 'desc'
      ? ArrowDown
      : ArrowUp
    : ArrowUpDown;

  return (
    <TableHead
      className={cn('cursor-pointer select-none', className)}
      onClick={() => onSort(column)}
    >
      <div
        className={cn(
          'flex items-center gap-1',
          align === 'right' && 'text-right justify-end',
        )}
      >
        <span>{label}</span>
        <Icon className={cn('size-3.5', !isActive && 'opacity-30')} />
      </div>
    </TableHead>
  );
}

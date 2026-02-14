import { Badge } from './badge';
import { TableRow, TableCell } from '@/components/ui/table';
import { formatDate } from '@/lib/format';
import type { Message } from '../../../src/db/schema';

export function MessageRow({ message }: { message: Message }) {
  const badges = (message.badges as string[]) || [];
  const symbols = (message.symbols as string[]) || [];

  return (
    <TableRow>
      <TableCell className="text-muted-foreground text-sm">
        {formatDate(message.timestamp)}
      </TableCell>
      <TableCell className="font-medium text-foreground">{message.author}</TableCell>
      <TableCell className="text-sm text-muted-foreground max-w-md truncate">
        {message.cleanText}
      </TableCell>
      <TableCell>
        <div className="flex gap-1 flex-wrap">
          {badges.map((b, i) => (
            <Badge key={i} label={b} />
          ))}
        </div>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {symbols.join(', ')}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {message.confidence ?? '--'}
      </TableCell>
    </TableRow>
  );
}

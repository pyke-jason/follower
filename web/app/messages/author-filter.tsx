'use client';

import { useRouter } from 'next/navigation';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';

export function AuthorFilter({
  authors,
  current,
}: {
  authors: string[];
  current?: string;
}) {
  const router = useRouter();

  return (
    <div className="flex items-center gap-2">
      <Label className="text-xs text-muted-foreground">Author:</Label>
      <Select
        value={current ?? 'all'}
        onValueChange={(val) => {
          router.push(val !== 'all' ? `/messages?author=${val}` : '/messages');
        }}
      >
        <SelectTrigger size="sm" className="w-36 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          {authors.map((a) => (
            <SelectItem key={a} value={a}>
              {a}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

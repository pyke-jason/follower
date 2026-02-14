import { getMessages, getDistinctAuthors } from '@/lib/queries';
import { MessageRow } from '../components/message-row';
import { AuthorFilter } from './author-filter';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ author?: string; page?: string }>;
}) {
  const params = await searchParams;
  const author = params.author;
  const page = parseInt(params.page ?? '1');
  const limit = 50;
  const offset = (page - 1) * limit;

  const [messages, authors] = await Promise.all([
    getMessages({ author, limit, offset }),
    getDistinctAuthors(),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-foreground">Messages</h2>
        <AuthorFilter authors={authors} current={author} />
      </div>

      <Card className="py-0 gap-0 overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs text-muted-foreground uppercase">Time</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Author</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Message</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Badges</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Symbols</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Conf</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {messages.map((m) => (
                <MessageRow key={m.id} message={m} />
              ))}
            </TableBody>
          </Table>
          {messages.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">
              No messages found
            </p>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex gap-2 justify-center items-center">
        {page > 1 && (
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/messages?page=${page - 1}${author ? `&author=${author}` : ''}`}>
              Previous
            </Link>
          </Button>
        )}
        <span className="text-sm text-muted-foreground">Page {page}</span>
        {messages.length === limit && (
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/messages?page=${page + 1}${author ? `&author=${author}` : ''}`}>
              Next
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

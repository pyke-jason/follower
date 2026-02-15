import { getMessages, getDistinctAuthors } from '@/lib/queries';
import { ChatRoom } from './chat-room';

export const dynamic = 'force-dynamic';

export default async function MessagesPage() {
  const [messages, authors] = await Promise.all([
    getMessages({ limit: 51 }), // extra one for cursor detection
    getDistinctAuthors(),
  ]);

  const hasMore = messages.length > 50;
  const initialMessages = hasMore ? messages.slice(0, 50) : messages;
  const nextCursor = hasMore
    ? initialMessages[initialMessages.length - 1].timestamp
    : null;

  return (
    // -m-6 counteracts the parent p-6 for full-bleed chat layout
    <div className="-m-6 h-[calc(100vh)] flex flex-col">
      <ChatRoom
        initialMessages={initialMessages}
        initialCursor={nextCursor}
        authors={authors}
      />
    </div>
  );
}

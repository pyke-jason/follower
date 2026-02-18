import { getMessages, getDistinctAuthors, getLatestIntents, getLabelsForMessages } from '@/lib/queries';
import { ChatRoom } from './chat-room';
import { AutoRefresh } from '../components/auto-refresh';

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

  const ids = initialMessages.map((m) => m.id);
  const [intents, labels] = await Promise.all([
    getLatestIntents(ids),
    getLabelsForMessages(ids),
  ]);

  return (
    // -m-6 counteracts the parent p-6 for full-bleed chat layout
    <div className="-m-6 h-full flex flex-col">
      <AutoRefresh />
      <ChatRoom
        initialMessages={initialMessages}
        initialCursor={nextCursor}
        initialIntents={intents}
        initialLabels={labels}
        authors={authors}
      />
    </div>
  );
}

import { ChatRoom } from './chat-room';
import { AutoRefresh } from '../components/auto-refresh';
import { loadInitialChatData } from './load-chat-data';

export const dynamic = 'force-dynamic';

export default async function MessagesPage() {
  const data = await loadInitialChatData({});

  return (
    // -m-6 counteracts the parent p-6 for full-bleed chat layout
    <div className="-m-6 h-full flex flex-col">
      <AutoRefresh />
      <ChatRoom
        initialMessages={data.messages}
        initialCursor={data.cursor}
        initialLabels={data.labels}
        initialEnrichment={data.enrichment}
        authors={data.authors}
      />
    </div>
  );
}

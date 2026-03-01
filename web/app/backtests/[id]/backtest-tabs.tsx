'use client';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, type ReactNode } from 'react';

const VALID_TABS = ['trades', 'messages', 'performance'] as const;
type TabValue = (typeof VALID_TABS)[number];

export function BacktestTabs({
  performance,
  messages,
  trades,
  hasMessages,
  tabBarTrailing,
}: {
  performance: ReactNode;
  messages: ReactNode;
  trades: ReactNode;
  hasMessages: boolean;
  tabBarTrailing?: ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const activeTab: TabValue = VALID_TABS.includes(rawTab as TabValue)
    ? (rawTab as TabValue)
    : 'trades';

  const handleTabChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'trades') {
        params.delete('tab');
      } else {
        params.set('tab', value);
      }
      const qs = params.toString();
      router.replace(`?${qs}`, { scroll: false });
    },
    [router, searchParams],
  );

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2">
        <TabsList variant="line">
          <TabsTrigger value="trades">Trades</TabsTrigger>
          <TabsTrigger value="messages">
            Messages
            {hasMessages && (
              <span className="ml-1 text-xs text-muted-foreground">&middot;</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
        </TabsList>
        {activeTab === 'trades' && tabBarTrailing && (
          <div className="ml-auto">{tabBarTrailing}</div>
        )}
      </div>

      <TabsContent value="trades" className="mt-2 flex flex-col min-h-0">
        {trades}
      </TabsContent>

      <TabsContent value="messages" className="mt-2 flex flex-col flex-1 min-h-0">
        {messages}
      </TabsContent>

      <TabsContent value="performance" className="mt-2 overflow-auto min-h-0 space-y-4">
        {performance}
      </TabsContent>
    </Tabs>
  );
}

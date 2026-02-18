'use client';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, type ReactNode } from 'react';

const VALID_TABS = ['performance', 'messages', 'trades', 'accuracy'] as const;
type TabValue = (typeof VALID_TABS)[number];

export function BacktestTabs({
  performance,
  messages,
  trades,
  accuracy,
  hasMessages,
  hasAccuracy,
}: {
  performance: ReactNode;
  messages: ReactNode;
  trades: ReactNode;
  accuracy: ReactNode;
  hasMessages: boolean;
  hasAccuracy: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const activeTab: TabValue = VALID_TABS.includes(rawTab as TabValue)
    ? (rawTab as TabValue)
    : 'performance';

  const handleTabChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'performance') {
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
      <TabsList variant="line">
        <TabsTrigger value="performance">Performance</TabsTrigger>
        <TabsTrigger value="messages">
          Messages
          {hasMessages && (
            <span className="ml-1 text-xs text-muted-foreground">&middot;</span>
          )}
        </TabsTrigger>
        <TabsTrigger value="trades">Trades</TabsTrigger>
        {hasAccuracy && (
          <TabsTrigger value="accuracy">Accuracy</TabsTrigger>
        )}
      </TabsList>

      <TabsContent value="performance" className="space-y-4 mt-2">
        {performance}
      </TabsContent>

      <TabsContent value="messages" className="mt-2 flex flex-col flex-1 min-h-0">
        {messages}
      </TabsContent>

      <TabsContent value="trades" className="mt-2">
        {trades}
      </TabsContent>

      {hasAccuracy && (
        <TabsContent value="accuracy" className="space-y-4 mt-2">
          {accuracy}
        </TabsContent>
      )}
    </Tabs>
  );
}

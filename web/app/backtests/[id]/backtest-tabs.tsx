'use client';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import type { ReactNode } from 'react';

export function BacktestTabs({
  performance,
  decisions,
  trades,
  hasDecisions,
}: {
  performance: ReactNode;
  decisions: ReactNode;
  trades: ReactNode;
  hasDecisions: boolean;
}) {
  return (
    <Tabs defaultValue="performance">
      <TabsList variant="line">
        <TabsTrigger value="performance">Performance</TabsTrigger>
        <TabsTrigger value="decisions">
          Agent Decisions
          {hasDecisions && (
            <span className="ml-1 text-xs text-muted-foreground">&middot;</span>
          )}
        </TabsTrigger>
        <TabsTrigger value="trades">Trades</TabsTrigger>
      </TabsList>

      <TabsContent value="performance" className="space-y-4 mt-2">
        {performance}
      </TabsContent>

      <TabsContent value="decisions" className="mt-2">
        {decisions}
      </TabsContent>

      <TabsContent value="trades" className="mt-2">
        {trades}
      </TabsContent>
    </Tabs>
  );
}

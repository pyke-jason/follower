import { Suspense, lazy } from 'react';
import { Routes, Route, Outlet } from 'react-router-dom';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { ErrorBoundary } from './components/error-boundary';
import { ChannelScopeSync } from './components/channel-scope-provider';
import { AppSidebar } from './components/sidebar';
import { BacktestBanner } from './components/backtest-banner';
import { TopBar } from './components/top-bar';
import { useChannelStore } from '@/stores/channel-store';

// Lazy load pages
const Dashboard = lazy(() => import('./page'));
const Tasks = lazy(() => import('./tasks/page'));
const TaskDetail = lazy(() => import('./tasks/[id]/page'));
const Trades = lazy(() => import('./trades/page'));
const TradeDetail = lazy(() => import('./trades/[id]/page'));
const Traders = lazy(() => import('./traders/page'));
const TraderDetail = lazy(() => import('./traders/[name]/page'));
const Messages = lazy(() => import('./messages/page'));
const Backtests = lazy(() => import('./backtests/page'));
const NewBacktest = lazy(() => import('./backtests/new/page'));
const BacktestDetail = lazy(() => import('./backtests/[id]/page'));
const Reconciliation = lazy(() => import('./reconciliation/page'));
const Settings = lazy(() => import('./settings/page'));

const PageFallback = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin h-6 w-6 border-2 border-muted-foreground/20 border-t-foreground rounded-full" />
  </div>
);

function RootLayout() {
  const channelId = useChannelStore((s) => s.channelId);
  const brief = useChannelStore((s) => s.channelBrief);
  const status = useChannelStore((s) => s.status);
  const showBanner = status?.channelKind === 'backtest' && !!channelId && !!brief;

  return (
    <div
      className={`flex flex-col h-svh overflow-hidden ${showBanner ? 'has-banner' : ''}`}
      style={showBanner ? { '--banner-h': '2rem' } as React.CSSProperties : undefined}
    >
      <BacktestBanner />
      <SidebarProvider className="flex-1 min-h-0" defaultOpen={!document.cookie.includes('sidebar_state=false')}>
        <ChannelScopeSync />
        <AppSidebar />
        <SidebarInset className="overflow-hidden flex flex-col">
          <ErrorBoundary>
            <TopBar />
          </ErrorBoundary>
          <div className="flex-1 overflow-auto overscroll-contain px-6 pt-6 relative">
            <ErrorBoundary>
              <Suspense fallback={<PageFallback />}>
                <Outlet />
              </Suspense>
            </ErrorBoundary>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="tasks/:id" element={<TaskDetail />} />
        <Route path="trades" element={<Trades />} />
        <Route path="trades/:id" element={<TradeDetail />} />
        <Route path="traders" element={<Traders />} />
        <Route path="traders/:name" element={<TraderDetail />} />
        <Route path="messages" element={<Messages />} />
        <Route path="backtests" element={<Backtests />} />
        <Route path="backtests/new" element={<NewBacktest />} />
        <Route path="backtests/:id" element={<BacktestDetail />} />
        <Route path="reconciliation" element={<Reconciliation />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}

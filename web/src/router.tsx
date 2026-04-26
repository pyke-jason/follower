import { Suspense, lazy, useEffect } from 'react';
import { Routes, Route, Outlet, useLocation } from 'react-router-dom';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { ErrorBoundary } from './components/error-boundary';
import { ChannelScopeSync } from './components/channel-scope-provider';
import { AppSidebar } from './components/sidebar';
import { BacktestBanner } from './components/backtest-banner';
import { TopBar } from './components/top-bar';
import { CommandPalette } from './components/command-palette';
import { useChannelStore } from '@/stores/channel-store';

// Lazy load pages
const Dashboard = lazy(() => import('./views/dashboard/page'));
const Tasks = lazy(() => import('./views/tasks/page'));
const TaskDetail = lazy(() => import('./views/tasks/[id]/page'));
const Trades = lazy(() => import('./views/trades/page'));
const TradeDetail = lazy(() => import('./views/trades/[id]/page'));
const Traders = lazy(() => import('./views/traders/page'));
const TraderDetail = lazy(() => import('./views/traders/[name]/page'));
const Messages = lazy(() => import('./views/messages/page'));
const Backtests = lazy(() => import('./views/backtests/page'));
const NewBacktest = lazy(() => import('./views/backtests/new/page'));
const BacktestDetail = lazy(() => import('./views/backtests/[id]/page'));
const Classify = lazy(() => import('./views/classify/page'));
const NewClassify = lazy(() => import('./views/classify/new/page'));
const ClassifyDetail = lazy(() => import('./views/classify/[id]/page'));
const Reconciliation = lazy(() => import('./views/reconciliation/page'));
const AuditAlerts = lazy(() => import('./views/audits/page'));
const Settings = lazy(() => import('./views/settings/page'));
const EvalReview = lazy(() => import('./views/eval/review/page'));
const Architecture = lazy(() => import('./views/architecture/page'));
const DbBrowser = lazy(() => import('./views/db-browser/page'));

const PageFallback = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin h-5 w-5 border-2 border-primary/20 border-t-primary rounded-full" />
  </div>
);

/** Move focus to #main-content on every route change so keyboard users aren't stranded in the sidebar. */
function FocusOnRouteChange() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.getElementById('main-content')?.focus();
  }, [pathname]);
  return null;
}

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
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-foreground focus:border"
      >
        Skip to main content
      </a>
      <FocusOnRouteChange />
      <CommandPalette />
      <BacktestBanner />
      <SidebarProvider className="flex-1 min-h-0" defaultOpen={!document.cookie.includes('sidebar_state=false')}>
        <ChannelScopeSync />
        <AppSidebar />
        <SidebarInset className="overflow-hidden flex flex-col">
          <ErrorBoundary>
            <TopBar />
          </ErrorBoundary>
          <div
            id="main-content"
            tabIndex={-1}
            className="flex-1 overflow-auto overscroll-contain px-6 pt-6 relative outline-none"
          >
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
        <Route path="classify" element={<Classify />} />
        <Route path="classify/new" element={<NewClassify />} />
        <Route path="classify/:id" element={<ClassifyDetail />} />
        <Route path="reconciliation" element={<Reconciliation />} />
        <Route path="audits" element={<AuditAlerts />} />
        <Route path="eval/review" element={<EvalReview />} />
        <Route path="architecture" element={<Architecture />} />
        <Route path="db" element={<DbBrowser />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}

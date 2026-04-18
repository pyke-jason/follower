import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { App } from './router';
import './globals.css';

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      // Only show toast for background refetch failures when stale data exists
      if (query.state.data !== undefined) {
        toast.error(`Background refresh failed: ${error.message}`);
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      // Skip if the mutation has its own onError handler
      if (mutation.options.onError) return;
      toast.error(error.message || 'Something went wrong');
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      throwOnError: (error: unknown) => {
        if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
          return error.status >= 500;
        }
        return false;
      },
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </TooltipProvider>
      <Toaster richColors />
    </QueryClientProvider>
  </StrictMode>,
);

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { MousePointerClick } from 'lucide-react';
import { api } from '@/lib/api';
import { useEvalReviewParams } from '@/hooks/use-eval-review-params';
import { useEvalNav } from '@/hooks/use-eval-nav';
import { QueryBoundary, TableSkeleton } from '@/components/query-boundary';
import { EmptyState } from '@/components/empty-state';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { EvalReviewList } from './eval-review-list';
import { EvalReviewDetail } from './eval-review-detail';
import type { LabelsResponse } from './types';

export default function EvalReviewPage() {
  const { source, verified, confidence, isTrade, sort } = useEvalReviewParams();

  const query = useQuery<LabelsResponse>({
    queryKey: ['eval-labels', source, verified, confidence, isTrade, sort.dir],
    queryFn: () => {
      const p = new URLSearchParams({ limit: '5000', sort: sort.dir });
      if (source) p.set('source', source);
      if (verified) p.set('verified', verified);
      if (confidence) p.set('confidence', confidence);
      if (isTrade) p.set('isTrade', isTrade);
      return api<LabelsResponse>(`/eval/labels?${p}`);
    },
    placeholderData: keepPreviousData,
  });

  return (
    <QueryBoundary query={query} skeleton={<TableSkeleton />}>
      {(data) => <EvalReviewContent data={data} />}
    </QueryBoundary>
  );
}

function EvalReviewContent({ data }: { data: LabelsResponse }) {
  const nav = useEvalNav(data.rows);

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-[calc(100svh-var(--banner-h,0px)-3.5rem)]">
      <ResizablePanel defaultSize={40} minSize={25}>
        <EvalReviewList data={data} currentId={nav.current?.id ?? null} onSelect={nav.goTo} />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={60} minSize={35}>
        {nav.current ? (
          <EvalReviewDetail items={data.rows} nav={nav} />
        ) : (
          <div className="flex items-center justify-center h-full">
            <EmptyState
              title="Select a label to review"
              hint="Click a row or use arrow keys to navigate"
              icon={<MousePointerClick className="size-6 text-muted-foreground" />}
            />
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

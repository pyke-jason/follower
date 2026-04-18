import { useQuery } from '@tanstack/react-query';
import { queries } from '@/lib/queries';
import { ClassifyList } from './classify-list';
import { QueryBoundary, TableSkeleton } from '@/components/query-boundary';

export default function ClassifyPage() {
  const query = useQuery(queries.classify.list());

  return (
    <QueryBoundary query={query} skeleton={<TableSkeleton />}>
      {(runs) => (
        <div className="h-full flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-foreground shrink-0">Classify Runs</h2>
          <ClassifyList runs={runs} />
        </div>
      )}
    </QueryBoundary>
  );
}

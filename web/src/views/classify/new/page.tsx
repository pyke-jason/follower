import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { ClassifyForm } from './classify-form';
import { Spinner } from '@/components/spinner';

export default function NewClassifyPage() {
  const { data: trackedTraders } = useQuery<Array<{ name: string }>>({
    queryKey: ['trader-names'],
    queryFn: () => api('/tracked-traders'),
  });

  if (!trackedTraders) return <Spinner />;

  const traderOptions = trackedTraders.map((t) => t.name);
  const defaultTraders = traderOptions;

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div className="flex items-center gap-3">
        <Link to="/classify" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Classify
        </Link>
        <h2 className="text-lg font-semibold text-foreground">New Classify Run</h2>
      </div>

      <Card className="py-4 gap-3">
        <CardContent>
          <ClassifyForm traderOptions={traderOptions} defaultTraders={defaultTraders} />
        </CardContent>
      </Card>
    </div>
  );
}

import { computeGlobalAccuracy } from '@/lib/queries';
import { AccuracyGrid } from '../components/accuracy-grid';
import { Card, CardContent } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function EvalPage() {
  const result = await computeGlobalAccuracy();

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-foreground">Eval Dashboard</h2>

      {result ? (
        <AccuracyGrid result={result} />
      ) : (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No reviewed labels yet. Go to the{' '}
              <a href="/messages" className="underline">Messages</a> page
              and use the checkmark/pencil buttons on intent strips to start labeling.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

import { Link } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { useScopedHref } from '@/hooks/use-scoped-href';
import type { ReconciliationAlert } from '@src/db/schema';

const TYPE_DESCRIPTION: Record<string, string> = {
  BROKER_ONLY: 'Broker reports a position the database does not know about.',
  DB_ONLY: 'Database has this trade open but the broker shows no matching position.',
  QUANTITY_MISMATCH: 'Broker quantity does not match the trade record.',
};

export function ReconAlertBanner({ alerts }: { alerts: ReconciliationAlert[] }) {
  const href = useScopedHref();
  if (alerts.length === 0) return null;

  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>
        {alerts.length === 1
          ? 'Reconciliation alert'
          : `${alerts.length} reconciliation alerts`}
      </AlertTitle>
      <AlertDescription>
        <div className="space-y-1">
          {alerts.map((a) => (
            <div key={a.id} className="flex items-center gap-2 text-xs">
              <span className="font-mono font-medium">{a.type}</span>
              <span>{TYPE_DESCRIPTION[a.type] ?? 'Broker vs database mismatch.'}</span>
            </div>
          ))}
          <Link
            to={href('/recon-alerts')}
            className="inline-block text-xs font-medium text-foreground hover:underline mt-1"
          >
            Review in reconciliation →
          </Link>
        </div>
      </AlertDescription>
    </Alert>
  );
}

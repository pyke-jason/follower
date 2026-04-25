import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/badge';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle } from 'lucide-react';
import { relativeTime } from '@/lib/format';
import type { ReconciliationAlert } from '@src/db/schema';

export function RecentAlertsPanel({ alerts }: { alerts: ReconciliationAlert[] }) {
  const href = useScopedHref();
  if (alerts.length === 0) return null;

  const unresolvedCount = alerts.filter((a) => !a.resolved).length;

  return (
    <Card className="py-0 gap-0 overflow-hidden">
      <CardContent className="p-0">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/40">
          <span className="text-xs font-semibold">Recent Alerts</span>
          <div className="flex items-center gap-3">
            {unresolvedCount > 0 && (
              <span className="text-xs font-mono text-loss tabular-nums">{unresolvedCount} unresolved</span>
            )}
            <Link
              to={href('/reconciliation')}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              View all →
            </Link>
          </div>
        </div>
        <ul className="divide-y divide-border/40">
          {alerts.map((alert) => (
            <li key={alert.id} className="flex items-center gap-3 px-4 py-2">
              {alert.resolved ? (
                <CheckCircle className="h-3 w-3 shrink-0 text-muted-foreground/30" />
              ) : (
                <AlertTriangle className="h-3 w-3 shrink-0 text-warning" />
              )}
              <span className="text-xs font-medium font-mono truncate flex-1">{alert.symbol}</span>
              <Badge label={alert.type} />
              {alert.resolved && <Badge label="RESOLVED" />}
              {alert.createdAt && (
                <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">
                  {relativeTime(alert.createdAt)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

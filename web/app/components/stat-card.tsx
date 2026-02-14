import { Card, CardContent } from '@/components/ui/card';

export function StatCard({
  label,
  value,
  color = 'text-foreground',
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <Card className="py-4 gap-1">
      <CardContent>
        <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
        <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

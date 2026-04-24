import { Link } from 'react-router-dom';
import { Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useScopedHref } from '@/hooks/use-scoped-href';


export function SignalSheet() {
  const href = useScopedHref();

  return (
    <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs font-normal px-2.5" asChild>
      <Link to={href('/messages', { signals: true })}>
        <Radio className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="hidden sm:inline">Signals</span>
      </Link>
    </Button>
  );
}

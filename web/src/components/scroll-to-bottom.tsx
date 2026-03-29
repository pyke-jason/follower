import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ScrollToBottom({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="icon"
      onClick={onClick}
      className="absolute bottom-3 right-3 rounded-full shadow-warm-md"
      aria-label="Scroll to bottom"
    >
      <ArrowDown className="size-3.5" />
    </Button>
  );
}

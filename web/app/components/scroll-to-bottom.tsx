import { ArrowDown } from 'lucide-react';

export function ScrollToBottom({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="absolute bottom-3 right-3 p-1.5 rounded-full bg-card border border-border text-muted-foreground hover:bg-accent hover:text-foreground shadow-warm-md transition-colors"
      aria-label="Scroll to bottom"
    >
      <ArrowDown className="size-3.5" />
    </button>
  );
}

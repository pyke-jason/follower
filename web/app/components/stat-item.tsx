import type { ReactNode } from 'react';

export function StatItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">
        {label}
      </p>
      {children}
    </div>
  );
}

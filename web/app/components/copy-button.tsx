'use client';

import { useState, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function CopyButton({
  getText,
  className,
}: {
  getText: () => string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    const text = getText();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [getText]);

  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn('h-6 w-6 p-0', className)}
      onClick={(e) => { e.stopPropagation(); copy(); }}
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-profit" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

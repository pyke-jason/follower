'use client';

import { useCallback } from 'react';
import { MessageSquareQuote } from 'lucide-react';
import { getAuthorTextColor } from '@/lib/author-colors';

export function QuoteDisplay({
  author,
  text,
  messageRef,
}: {
  author?: string;
  text: string;
  messageRef?: string;
}) {
  const handleClick = useCallback(() => {
    if (!messageRef) return;
    const el = document.querySelector(`[data-message-id="${messageRef}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('quote-highlight');
    el.addEventListener(
      'animationend',
      () => el.classList.remove('quote-highlight'),
      { once: true },
    );
  }, [messageRef]);

  const interactive = !!messageRef;

  return (
    <div
      onClick={interactive ? handleClick : undefined}
      className={`border-l-2 border-muted-foreground/30 bg-muted/40 rounded-r pl-3 pr-3 py-2 ${
        interactive ? 'cursor-pointer hover:bg-muted/60 transition-colors' : ''
      }`}
    >
      {author && (
        <div className="flex items-center gap-1 mb-0.5">
          <MessageSquareQuote className="w-3 h-3 text-muted-foreground" />
          <span
            className="text-xs font-medium"
            style={{ color: getAuthorTextColor(author) }}
          >
            {author}
          </span>
        </div>
      )}
      <p className="text-xs text-muted-foreground italic leading-relaxed">
        {text}
      </p>
    </div>
  );
}

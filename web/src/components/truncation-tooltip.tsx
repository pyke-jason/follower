import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type HoverState = {
  id: number;
  rect: DOMRect;
  text: string;
};

const MAX_ANCESTOR_DEPTH = 6;
const SUBPIXEL_TOLERANCE = 1;

function isClipped(el: HTMLElement): boolean {
  if (el.hasAttribute('title')) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return false;

  const style = getComputedStyle(el);

  const overflowHidden =
    style.overflow === 'hidden' ||
    style.overflow === 'clip' ||
    style.overflowX === 'hidden' ||
    style.overflowX === 'clip';
  const horizClipped =
    overflowHidden &&
    style.textOverflow === 'ellipsis' &&
    el.scrollWidth - el.clientWidth > SUBPIXEL_TOLERANCE;

  const lineClamp = style.webkitLineClamp;
  const clampCount = lineClamp && lineClamp !== 'none' ? Number(lineClamp) : 0;
  const vertClipped =
    clampCount > 0 && el.scrollHeight - el.clientHeight > SUBPIXEL_TOLERANCE;

  return horizClipped || vertClipped;
}

function findClippedAncestor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  // Never double up on an existing Radix tooltip
  if (target.closest('[data-slot="tooltip-trigger"]')) return null;

  let el: Element | null = target;
  let depth = 0;
  while (el && depth < MAX_ANCESTOR_DEPTH) {
    if (el instanceof HTMLElement && isClipped(el)) return el;
    el = el.parentElement;
    depth++;
  }
  return null;
}

export function TruncationTooltip() {
  const [state, setState] = useState<HoverState | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const currentElRef = useRef<HTMLElement | null>(null);
  const idRef = useRef(0);

  useEffect(() => {
    const handleOver = (e: MouseEvent) => {
      const el = findClippedAncestor(e.target);
      if (el === currentElRef.current) return;
      currentElRef.current = el;
      if (!el) {
        setState(null);
        return;
      }
      setState({
        id: ++idRef.current,
        rect: el.getBoundingClientRect(),
        text: (el.textContent ?? '').trim(),
      });
    };

    const clear = () => {
      currentElRef.current = null;
      setState(null);
    };

    document.addEventListener('mouseover', handleOver);
    // Any scroll, wheel, or key event invalidates the cached rect — close rather than chase it
    window.addEventListener('scroll', clear, true);
    window.addEventListener('wheel', clear, { passive: true });
    window.addEventListener('keydown', clear);
    return () => {
      document.removeEventListener('mouseover', handleOver);
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('wheel', clear);
      window.removeEventListener('keydown', clear);
    };
  }, []);

  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a || !state) return;
    a.style.top = `${state.rect.top}px`;
    a.style.left = `${state.rect.left}px`;
    a.style.width = `${state.rect.width}px`;
    a.style.height = `${state.rect.height}px`;
  }, [state]);

  return (
    <Tooltip open={!!state && state.text.length > 0}>
      <TooltipTrigger asChild>
        <div
          ref={anchorRef}
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed"
        />
      </TooltipTrigger>
      <TooltipContent className="max-w-md whitespace-normal break-words text-left">
        {state?.text}
      </TooltipContent>
    </Tooltip>
  );
}

import { useEffect, useState, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { useReviewNav } from '@/hooks/use-review-nav';
import { Badge } from '../../components/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { DiscrepancyReview } from '@src/db/schema';

// ── Types ──────────────────────────────────────────────────────────────────

type ReviewResponse = {
  rows: DiscrepancyReview[];
  total: number;
  stats: {
    total: number;
    reviewed: number;
    parserRight: number;
    labelRight: number;
    bothWrong: number;
    skipped: number;
  };
};

type Verdict = 'parser_right' | 'label_right' | 'both_wrong' | 'skip';

const CATEGORIES = [
  { value: '', label: 'All' },
  { value: 'false_positive', label: 'False Pos' },
  { value: 'false_negative', label: 'False Neg' },
  { value: 'action_mismatch', label: 'Action' },
  { value: 'strategy_mismatch', label: 'Strategy' },
  { value: 'direction_mismatch', label: 'Direction' },
];

const CATEGORY_SHORT: Record<string, string> = {
  false_positive: 'FP',
  false_negative: 'FN',
  action_mismatch: 'Action',
  strategy_mismatch: 'Strategy',
  direction_mismatch: 'Direction',
};

// ── Page ───────────────────────────────────────────────────────────────────

export default function ReviewPage() {
  const [reason, setReason] = useState('');
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  // Fetch discrepancies
  // Nav hook needs items, but items come from the query which needs nav state.
  // Break the cycle: read filters from URL directly for the query, pass items to the hook.
  const params = new URLSearchParams(window.location.search);
  const catFilter = params.get('cat') ?? '';
  const reviewedFilter = params.get('reviewed') === 'true';

  const { data, isLoading } = useQuery<ReviewResponse>({
    queryKey: ['eval-review', catFilter, reviewedFilter],
    queryFn: () => {
      const p = new URLSearchParams({ limit: '5000' });
      if (catFilter) p.set('category', catFilter);
      if (!reviewedFilter) p.set('reviewed', 'false');
      return api<ReviewResponse>(`/eval/review?${p}`);
    },
  });

  const items = data?.rows ?? [];
  const stats = data?.stats;
  const nav = useReviewNav(items);

  const voteMut = useApiMutation<{ id: string; verdict: Verdict; reason?: string }>(
    'POST',
    (v) => `/eval/review/${v.id}`,
    {
      body: (v) => ({ verdict: v.verdict, reason: v.reason }),
      invalidate: [['eval-review']],
      onSuccess: () => setReason(''),
    },
  );

  const vote = useCallback((verdict: Verdict) => {
    if (!nav.current || voteMut.isPending) return;
    voteMut.mutate({ id: nav.current.id, verdict, reason: reason || undefined });
  }, [nav.current, reason, voteMut]);

  // Keyboard
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }
      switch (e.key) {
        case '1': e.preventDefault(); vote('parser_right'); break;
        case '2': e.preventDefault(); vote('label_right'); break;
        case '3': e.preventDefault(); vote('both_wrong'); break;
        case 's': e.preventDefault(); vote('skip'); break;
        case 'j': case 'ArrowDown': e.preventDefault(); nav.go(1); break;
        case 'k': case 'ArrowUp': e.preventDefault(); nav.go(-1); break;
        case 'r': e.preventDefault(); reasonRef.current?.focus(); break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vote, nav]);

  if (isLoading) return <ReviewSkeleton />;

  const reviewed = stats?.reviewed ?? 0;
  const total = stats?.total ?? 0;
  const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0;
  const current = nav.current;

  return (
    <div className="flex flex-col h-[calc(100svh-var(--banner-h,0px)-3.5rem)]">
      {/* Content */}
      <div className={cn('flex-1 overflow-auto transition-opacity duration-150', voteMut.isPending && 'opacity-60')}>
        {current ? (
          <div key={current.id} className="max-w-3xl mx-auto py-6 px-4 animate-in fade-in duration-200">
            {/* Header */}
            <div className="flex items-center gap-2 mb-1 text-sm">
              <span className="font-medium">{current.author}</span>
              <span className="text-muted-foreground">&middot;</span>
              <span className="text-muted-foreground">{new Date(current.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              <span className="text-muted-foreground">&middot;</span>
              <span className="text-xs font-medium text-muted-foreground">{CATEGORY_SHORT[current.category] ?? current.category}</span>
            </div>

            {/* Badges + symbols */}
            {((current.badges as string[]).length > 0 || (current.symbols as string[]).length > 0) && (
              <div className="flex gap-1 mb-3">
                {(current.badges as string[]).map(b => <Badge key={b} label={b} />)}
                {(current.symbols as string[]).map(s => (
                  <span key={s} className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{s}</span>
                ))}
              </div>
            )}

            {/* Message */}
            <p className="text-base leading-relaxed mb-6">{current.cleanText}</p>

            {/* Parser vs Label */}
            <div className="grid grid-cols-2 gap-4 mb-4">
              <FieldCard title="Parser" action={current.parserAction} strategy={current.parserStrategy} direction={current.parserDirection}
                extra={current.parserSkipReason ? `skip: ${current.parserSkipReason}` : (current.parserFlags as string[]).length > 0 ? `flags: ${(current.parserFlags as string[]).join(', ')}` : undefined} />
              <FieldCard title="Label" action={current.labelAction} strategy={current.labelStrategy} direction={current.labelDirection}
                extra={current.labelNotes ?? undefined} />
            </div>

            {/* Agent reasoning */}
            {current.agentReason && (
              <div className="text-xs text-muted-foreground border-t pt-3 mt-2">
                <span className="font-medium">Agent says {current.agentVerdict?.replace('_', ' ')}:</span>{' '}
                {current.agentReason}
              </div>
            )}

            {/* Notes */}
            <textarea
              ref={reasonRef}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Notes (R to focus, Esc to blur)"
              className="mt-4 w-full px-3 py-2 text-sm rounded-md border bg-transparent resize-none h-12 focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
            />
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {items.length === 0 ? 'No discrepancies to review' : 'Done'}
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="shrink-0 border-t bg-card">
        <div className="max-w-3xl mx-auto flex items-center justify-between px-4 py-2.5">
          {/* Nav + progress */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <button onClick={() => nav.go(-1)} disabled={nav.currentIdx === 0} className="px-1.5 py-0.5 text-xs text-muted-foreground rounded hover:bg-muted disabled:opacity-20">
                <kbd className="font-mono">k</kbd>
              </button>
              <span className="text-xs tabular-nums text-muted-foreground min-w-[60px] text-center">
                {nav.total > 0 ? `${nav.currentIdx + 1} / ${nav.total}` : '—'}
              </span>
              <button onClick={() => nav.go(1)} disabled={nav.currentIdx >= nav.total - 1} className="px-1.5 py-0.5 text-xs text-muted-foreground rounded hover:bg-muted disabled:opacity-20">
                <kbd className="font-mono">j</kbd>
              </button>
            </div>
            <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-foreground/30 rounded-full transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">{reviewed}/{total}</span>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-1">
            {CATEGORIES.map(cat => (
              <button key={cat.value} onClick={() => nav.setCategory(cat.value)}
                className={cn('px-2 py-0.5 text-xs rounded transition-colors',
                  nav.category === cat.value ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
                {cat.label}
              </button>
            ))}
            <button onClick={() => nav.setShowReviewed(!nav.showReviewed)}
              className={cn('px-2 py-0.5 text-xs rounded ml-1 transition-colors',
                nav.showReviewed ? 'text-muted-foreground hover:text-foreground' : 'bg-foreground/10 text-foreground')}>
              {nav.showReviewed ? 'All' : 'Unreviewed'}
            </button>
          </div>

          {/* Verdicts */}
          <div className="flex items-center gap-1.5">
            <VerdictButton label="Parser" kbd="1" onClick={() => vote('parser_right')} disabled={!current || voteMut.isPending} variant="positive" />
            <VerdictButton label="Label" kbd="2" onClick={() => vote('label_right')} disabled={!current || voteMut.isPending} variant="caution" />
            <VerdictButton label="Both" kbd="3" onClick={() => vote('both_wrong')} disabled={!current || voteMut.isPending} variant="negative" />
            <VerdictButton label="Skip" kbd="s" onClick={() => vote('skip')} disabled={!current || voteMut.isPending} variant="neutral" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Skeleton ────────────────────────────────────────────────────────────────

function ReviewSkeleton() {
  return (
    <div className="flex flex-col h-[calc(100svh-var(--banner-h,0px)-3.5rem)]">
      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto py-6 px-4">
          <div className="flex items-center gap-2 mb-3">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3.5 w-14" />
          </div>
          <div className="flex gap-1 mb-4">
            <Skeleton className="h-5 w-12 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <div className="space-y-2 mb-6">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Skeleton className="h-20 rounded-md" />
            <Skeleton className="h-20 rounded-md" />
          </div>
        </div>
      </div>
      <div className="shrink-0 border-t bg-card">
        <div className="max-w-3xl mx-auto flex items-center justify-between px-4 py-2.5">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-8 w-48" />
        </div>
      </div>
    </div>
  );
}

// ── Field Card ──────────────────────────────────────────────────────────────

function FieldCard({ title, action, strategy, direction, extra }: {
  title: string; action: string | null; strategy: string | null; direction: string | null; extra?: string;
}) {
  return (
    <div className="rounded-md border px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5">{title}</p>
      <div className="flex items-center gap-3 text-sm">
        <Field label="act" value={action} />
        <Field label="str" value={strategy} />
        <Field label="dir" value={direction} />
      </div>
      {extra && <p className="text-xs text-muted-foreground mt-1.5 truncate" title={extra}>{extra}</p>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <span className="text-sm">
      <span className="text-muted-foreground text-[10px] mr-0.5">{label}</span>{' '}
      <span className={cn('font-medium', !value && 'text-muted-foreground/40 italic')}>{value ?? '—'}</span>
    </span>
  );
}

// ── Verdict Button ──────────────────────────────────────────────────────────

function VerdictButton({ label, kbd, onClick, disabled, variant }: {
  label: string; kbd: string; onClick: () => void; disabled: boolean;
  variant: 'positive' | 'caution' | 'negative' | 'neutral';
}) {
  const styles = {
    positive: 'hover:bg-profit/10 hover:text-profit',
    caution: 'hover:bg-warning/10 hover:text-warning',
    negative: 'hover:bg-loss/10 hover:text-loss',
    neutral: 'hover:bg-muted',
  };
  return (
    <button onClick={onClick} disabled={disabled}
      className={cn('flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border transition-colors disabled:opacity-30', styles[variant])}>
      <kbd className="font-mono text-muted-foreground">{kbd}</kbd>
      <span>{label}</span>
    </button>
  );
}

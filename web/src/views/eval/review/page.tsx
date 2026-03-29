import { useEffect, useState, useCallback, useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowUp, ArrowDown, ClipboardCheck, FilterX, MousePointerClick } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { Badge as AppBadge } from '@/components/badge';
import { Badge } from '@/components/ui/badge';
import { QueryBoundary, TableSkeleton } from '@/components/query-boundary';
import { Kbd } from '@/components/ui/kbd';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/empty-state';
import type { Signal } from '@src/agent/schemas';
import { formatDateShort, formatDate, formatTime } from '@/lib/format';

// ── Types ───────────────────────────────────────────────────────────────────

type EvalLabel = {
  reasoning: string;
  isTrade: boolean;
  confidence: 'HIGH' | 'LOW';
  trades: Signal[][];
};

type LabelRow = {
  id: string;
  messageId: string;
  label: EvalLabel;
  source: string;
  model: string | null;
  version: number;
  humanVerified: boolean;
  humanLabel: EvalLabel | null;
  reviewedAt: string | null;
  createdAt: string;
  author: string;
  timestamp: string;
  cleanText: string;
  badges: string[];
  symbols: string[];
};

type LabelsResponse = {
  rows: LabelRow[];
  total: number;
  stats: {
    total: number;
    verified: number;
    lowConfidence: number;
    bySource: { agent: number; human: number };
  };
};

type ChatContext = {
  target: string;
  author: string;
  messages: Array<{
    id: string;
    author: string;
    cleanText: string;
    badges: string[];
    symbols: string[];
    timestamp: string;
  }>;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Signal with a stable client-side ID for React keying */
type KeyedSignal = Signal & { _id: string };
type KeyedTrade = { _id: string; signals: KeyedSignal[] };

let _editorIdCounter = 0;
function nextEditorId(prefix: 'sig' | 'trade'): string {
  return `${prefix}-${++_editorIdCounter}`;
}

function keySignal(s: Signal): KeyedSignal {
  return { ...s, _id: nextEditorId('sig') };
}

function keyTrades(trades: Signal[][]): KeyedTrade[] {
  return trades.map((signals) => ({
    _id: nextEditorId('trade'),
    signals: signals.map(keySignal),
  }));
}

/** Strip client-side _id before sending to API */
function stripTrades(trades: KeyedTrade[]): Signal[][] {
  return trades.map((trade) => trade.signals.map(({ _id: _, ...rest }) => rest));
}

function emptySignal(): KeyedSignal {
  return {
    _id: nextEditorId('sig'),
    action: 'OPEN',
    symbol: '',
    direction: null,
    strategy: null,
    strikes: null,
    expiry: null,
    statedPrice: null,
    quantity: null,
  };
}

function emptyTrade(): KeyedTrade {
  return {
    _id: nextEditorId('trade'),
    signals: [emptySignal()],
  };
}

// ── Filters Hook ────────────────────────────────────────────────────────────

function useEvalFilters() {
  const [params, setParams] = useSearchParams();

  const source = params.get('source') ?? '';
  const verified = params.get('verified') ?? '';
  const confidence = params.get('confidence') ?? '';
  const sortDir = (params.get('dir') ?? 'desc') as 'asc' | 'desc';

  const updateParam = useCallback((key: string, value: string | null) => {
    setParams(p => {
      if (value) p.set(key, value); else p.delete(key);
      p.delete('id');
      return p;
    }, { replace: true });
  }, [setParams]);

  const activeCount = [source, verified, confidence].filter(Boolean).length;

  const clearFilters = useCallback(() => {
    setParams(p => {
      p.delete('source');
      p.delete('verified');
      p.delete('confidence');
      p.delete('id');
      return p;
    }, { replace: true });
  }, [setParams]);

  return {
    source,
    verified,
    confidence,
    sortDir,
    activeCount,
    clearFilters,
    setSource: useCallback((v: string) => updateParam('source', v || null), [updateParam]),
    setVerified: useCallback((v: string) => updateParam('verified', v || null), [updateParam]),
    setConfidence: useCallback((v: string) => updateParam('confidence', v || null), [updateParam]),
    setSortDir: useCallback((d: 'asc' | 'desc') => updateParam('dir', d === 'desc' ? null : d), [updateParam]),
  };
}

// ── Nav Hook ────────────────────────────────────────────────────────────────

function useEvalNav(items: LabelRow[]) {
  const [params, setParams] = useSearchParams();
  const activeId = params.get('id');

  const currentIdx = useMemo(() => {
    if (!activeId || items.length === 0) return 0;
    const idx = items.findIndex(r => r.id === activeId);
    return idx >= 0 ? idx : 0;
  }, [activeId, items]);

  const current = items[currentIdx] ?? null;

  const goTo = useCallback((id: string) => {
    setParams(p => { if (id) p.set('id', id); else p.delete('id'); return p; }, { replace: true });
  }, [setParams]);

  const go = useCallback((delta: number) => {
    const nextIdx = Math.max(0, Math.min(currentIdx + delta, items.length - 1));
    const next = items[nextIdx];
    if (next) goTo(next.id);
  }, [currentIdx, items, goTo]);

  /** Jump to the next unreviewed item after the current index. Wraps around. Falls back to sequential +1. */
  const goNextUnreviewed = useCallback(() => {
    // Search forward from currentIdx
    for (let i = currentIdx + 1; i < items.length; i++) {
      if (!items[i].humanVerified) {
        goTo(items[i].id);
        return;
      }
    }
    // Wrap around from start
    for (let i = 0; i < currentIdx; i++) {
      if (!items[i].humanVerified) {
        goTo(items[i].id);
        return;
      }
    }
    // All reviewed: fall back to next sequential
    const nextIdx = Math.min(currentIdx + 1, items.length - 1);
    const next = items[nextIdx];
    if (next) goTo(next.id);
  }, [currentIdx, items, goTo]);

  return { current, currentIdx, go, goTo, goNextUnreviewed, total: items.length };
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function EvalReviewPage() {
  const filters = useEvalFilters();

  const query = useQuery<LabelsResponse>({
    queryKey: ['eval-labels', filters.source, filters.verified, filters.confidence, filters.sortDir],
    queryFn: () => {
      const p = new URLSearchParams({ limit: '5000', sort: filters.sortDir });
      if (filters.source) p.set('source', filters.source);
      if (filters.verified) p.set('verified', filters.verified);
      if (filters.confidence) p.set('confidence', filters.confidence);
      return api<LabelsResponse>(`/eval/labels?${p}`);
    },
    placeholderData: keepPreviousData,
  });

  return (
    <QueryBoundary query={query} skeleton={<TableSkeleton />}>
      {(data) => <EvalReviewContent data={data} filters={filters} />}
    </QueryBoundary>
  );
}

function EvalReviewContent({ data, filters }: {
  data: LabelsResponse;
  filters: ReturnType<typeof useEvalFilters>;
}) {
  const items = data.rows;
  const stats = data.stats;
  const nav = useEvalNav(items);
  const current = nav.current;

  // Chat context
  const { data: chatCtx } = useQuery<ChatContext>({
    queryKey: ['eval-context', current?.id],
    queryFn: () => api<ChatContext>(`/eval/labels/${current!.id}/context`),
    enabled: !!current,
  });

  const [lastReviewedId, setLastReviewedId] = useState<string | null>(null);

  const verified = stats?.verified ?? 0;
  const total = stats?.total ?? 0;
  const pct = total > 0 ? Math.round((verified / total) * 100) : 0;

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-[calc(100svh-var(--banner-h,0px)-3.5rem)]">
      {/* Left: list */}
      <ResizablePanel defaultSize={40} minSize={25}>
        <div className="flex flex-col h-full">
          {/* Filters bar */}
          <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b shrink-0">
            {/* Verified filter */}
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={filters.verified || 'all'}
              onValueChange={v => { if (v) filters.setVerified(v === 'all' ? '' : v); }}
            >
              <ToggleGroupItem value="all" className="text-xs h-6 px-2">All</ToggleGroupItem>
              <ToggleGroupItem value="false" className="text-xs h-6 px-2">Unreviewed</ToggleGroupItem>
              <ToggleGroupItem value="true" className="text-xs h-6 px-2">Verified</ToggleGroupItem>
            </ToggleGroup>

            {/* Confidence filter */}
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={filters.confidence || 'all'}
              onValueChange={v => { if (v) filters.setConfidence(v === 'all' ? '' : v); }}
            >
              <ToggleGroupItem value="all" className="text-xs h-6 px-2">All</ToggleGroupItem>
              <ToggleGroupItem value="HIGH" className="text-xs h-6 px-2">HIGH</ToggleGroupItem>
              <ToggleGroupItem value="LOW" className="text-xs h-6 px-2">LOW</ToggleGroupItem>
            </ToggleGroup>

            {/* Source filter */}
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={filters.source || 'all'}
              onValueChange={v => { if (v) filters.setSource(v === 'all' ? '' : v); }}
            >
              <ToggleGroupItem value="all" className="text-xs h-6 px-2">All</ToggleGroupItem>
              <ToggleGroupItem value="agent" className="text-xs h-6 px-2">Agent</ToggleGroupItem>
              <ToggleGroupItem value="human" className="text-xs h-6 px-2">Human</ToggleGroupItem>
            </ToggleGroup>

            {/* Clear filters + active count */}
            {filters.activeCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={filters.clearFilters}
                className="text-xs h-6 px-1.5 text-muted-foreground gap-1"
              >
                <FilterX className="size-3" />
                Clear
                <Badge variant="secondary" className="text-[10px] h-4 px-1 min-w-[1ch]">
                  {filters.activeCount}
                </Badge>
              </Button>
            )}

            <div className="flex-1" />

            {/* Progress */}
            <span className="text-xs text-muted-foreground tabular-nums">{verified}/{total}</span>
            <Progress value={pct} className="w-16 h-1.5" />
          </div>

          {/* List */}
          <ScrollArea className="flex-1">
            {items.length === 0 ? (
              <EmptyState
                variant="filtered"
                title="No matching labels"
                hint="Try adjusting your filters"
                icon={<FilterX className="size-6 text-muted-foreground" />}
                action={
                  filters.activeCount > 0 ? (
                    <Button variant="outline" size="sm" onClick={filters.clearFilters}>
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <Table className="text-xs">
                <TableHeader className="sticky top-0 bg-background border-b z-10">
                  <TableRow>
                    <TableHead
                      className="text-left font-medium px-2 py-1.5 h-auto w-[56px] cursor-pointer select-none"
                      onClick={() => filters.setSortDir(filters.sortDir === 'asc' ? 'desc' : 'asc')}
                    >
                      <span className="inline-flex items-center gap-0.5">
                        Date
                        {filters.sortDir === 'asc'
                          ? <ArrowUp className="size-3" />
                          : <ArrowDown className="size-3" />
                        }
                      </span>
                    </TableHead>
                    <TableHead className="text-left font-medium px-1.5 py-1.5 h-auto w-[70px]">Author</TableHead>
                    <TableHead className="text-left font-medium px-1.5 py-1.5 h-auto">Message</TableHead>
                    <TableHead className="text-center font-medium px-1 py-1.5 h-auto w-[32px]">Conf</TableHead>
                    <TableHead className="text-center font-medium px-1 py-1.5 h-auto w-[20px]">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-default">V</span>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" sideOffset={4}>Verified</TooltipContent>
                      </Tooltip>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((row) => (
                    <TableRow
                      key={row.id}
                      className={cn(
                        'cursor-pointer hover:bg-muted/50 transition-colors',
                        row.id === current?.id && 'bg-accent',
                        row.humanVerified && 'border-l-2 border-l-profit',
                        !row.humanVerified && 'border-l-2 border-l-transparent',
                      )}
                      onClick={() => nav.goTo(row.id)}
                    >
                      <TableCell className="py-1.5 px-2 text-[10px] text-muted-foreground tabular-nums">
                        {formatDateShort(row.timestamp)}
                      </TableCell>
                      <TableCell className="py-1.5 px-1.5 truncate max-w-[70px]">{row.author}</TableCell>
                      <TableCell className="py-1.5 px-1.5 truncate max-w-[280px]">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="truncate block">{row.cleanText.slice(0, 120)}</span>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" sideOffset={4} className="max-w-sm">
                            {row.cleanText}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="py-1.5 px-1 text-center">
                        <ConfidenceDot confidence={row.label.confidence} />
                      </TableCell>
                      <TableCell className="py-1.5 px-1 text-center">
                        {row.humanVerified && (
                          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[8px] font-bold text-background bg-profit">
                            V
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </ScrollArea>
        </div>
      </ResizablePanel>

      <ResizableHandle withHandle />

      {/* Right: detail */}
      <ResizablePanel defaultSize={60} minSize={35}>
        {current ? (
          <DetailPanel
            current={current}
            chatCtx={chatCtx}
            nav={nav}
            lastReviewedId={lastReviewedId}
            setLastReviewedId={setLastReviewedId}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <EmptyState
              title="Select a label to review"
              hint="Click a row or use arrow keys to navigate"
              icon={<MousePointerClick className="size-6 text-muted-foreground" />}
            />
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

// ── Detail Panel (keyed by current.id to reset edit state) ──────────────────

function DetailPanel({
  current,
  chatCtx,
  nav,
  lastReviewedId,
  setLastReviewedId,
}: {
  current: LabelRow;
  chatCtx: ChatContext | undefined;
  nav: ReturnType<typeof useEvalNav>;
  lastReviewedId: string | null;
  setLastReviewedId: (id: string | null) => void;
}) {
  const [editMode, setEditMode] = useState(false);
  const [editLabel, setEditLabel] = useState<EditLabel | null>(null);

  useEffect(() => {
    setEditMode(false);
    setEditLabel(null);
  }, [current.id]);

  // Approve mutation
  const approveMut = useApiMutation<{ id: string }>(
    'POST',
    (v) => `/eval/labels/${v.id}/approve`,
    {
      invalidate: [['eval-labels']],
      onSuccess: (_data, vars) => {
        setLastReviewedId(vars.id);
        setEditMode(false);
        toast.success('Label approved');
        nav.goNextUnreviewed();
      },
    },
  );

  // Review mutation (submit corrected label)
  const reviewMut = useApiMutation<{ id: string; humanLabel: unknown }>(
    'POST',
    (v) => `/eval/labels/${v.id}/review`,
    {
      body: (v) => ({ humanLabel: v.humanLabel }),
      invalidate: [['eval-labels']],
      onSuccess: (_data, vars) => {
        setLastReviewedId(vars.id);
        setEditMode(false);
        setEditLabel(null);
        toast.success('Correction saved');
        nav.goNextUnreviewed();
      },
    },
  );

  // Undo mutation
  const undoMut = useApiMutation<{ id: string }>(
    'POST',
    (v) => `/eval/labels/${v.id}/undo`,
    {
      invalidate: [['eval-labels']],
      onSuccess: (_data, vars) => {
        setLastReviewedId(null);
        toast.success('Review undone');
        nav.goTo(vars.id);
      },
    },
  );

  const approve = useCallback(() => {
    if (approveMut.isPending) return;
    approveMut.mutate({ id: current.id });
  }, [current, approveMut]);

  const undo = useCallback(() => {
    if (!lastReviewedId || undoMut.isPending) return;
    undoMut.mutate({ id: lastReviewedId });
  }, [lastReviewedId, undoMut]);

  const submitEdit = useCallback(() => {
    if (!editLabel || reviewMut.isPending) return;
    const cleaned: EvalLabel = { ...editLabel, trades: stripTrades(editLabel.trades) };
    reviewMut.mutate({ id: current.id, humanLabel: cleaned });
  }, [current, editLabel, reviewMut]);

  // Enter edit mode
  const enterEdit = useCallback(() => {
    setEditLabel({ ...current.label, trades: keyTrades(current.label.trades ?? []) });
    setEditMode(true);
  }, [current]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInputFocused = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable;

      // Cmd+Enter or Ctrl+Enter to save in edit mode (works even in inputs)
      if (editMode && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submitEdit();
        return;
      }

      if (isInputFocused) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }

      if (editMode && e.key === 'Escape') {
        e.preventDefault();
        setEditMode(false);
        setEditLabel(null);
        return;
      }

      // 's' to save correction when not in an input
      if (editMode && e.key === 's') {
        e.preventDefault();
        submitEdit();
        return;
      }

      switch (e.key) {
        case 'a': e.preventDefault(); approve(); break;
        case 'e': e.preventDefault(); enterEdit(); break;
        case 'z': e.preventDefault(); undo(); break;
        case 'ArrowDown': e.preventDefault(); nav.go(1); break;
        case 'ArrowUp': e.preventDefault(); nav.go(-1); break;
        case 'Escape': e.preventDefault(); nav.goTo(''); break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [approve, undo, nav, editMode, enterEdit, submitEdit]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <ScrollArea className="flex-1">
        <div>
          <div className="max-w-2xl mx-auto py-5 px-5">
            {/* Header */}
            <div className="flex items-center gap-2 mb-1 text-sm">
              <span className="font-medium">{current.author}</span>
              <span className="text-muted-foreground text-xs">
                {formatDate(current.timestamp)}
              </span>
              <span className="text-xs text-muted-foreground">{current.source}</span>
            </div>

            {/* Badges + Symbols */}
            {((current.badges as string[]).length > 0 || (current.symbols as string[]).length > 0) && (
              <div className="flex gap-1 mb-2">
                {(current.badges as string[]).map((b, i) => <AppBadge key={`${b}-${i}`} label={b} />)}
                {(current.symbols as string[]).map(s => (
                  <span key={s} className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{s}</span>
                ))}
              </div>
            )}

            {/* Message */}
            <p className="text-sm leading-relaxed mb-4">{current.cleanText}</p>

            {/* Agent Label */}
            {!editMode ? (
              <LabelDisplay label={current.label} title="Agent Label" />
            ) : (
              <LabelEditor label={editLabel!} onChange={setEditLabel} />
            )}

            {/* Human label diff (if already reviewed) */}
            {current.humanVerified && !editMode && (
              <div className="mt-3">
                {current.humanLabel ? (
                  <LabelDisplay label={current.humanLabel} title="Human Correction" />
                ) : (
                  <div className="text-xs text-profit flex items-center gap-1.5 px-3 py-2 bg-profit/5 rounded-md border border-profit/20">
                    <ClipboardCheck className="size-3.5" />
                    Approved (agent label is correct)
                  </div>
                )}
              </div>
            )}

            {/* Chat context */}
            {chatCtx && chatCtx.messages.length > 1 && (
              <div className="border rounded-md mt-4">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-3 py-1.5 border-b">
                  Chat Context ({chatCtx.messages.length} messages)
                </p>
                <div className="max-h-48 overflow-auto divide-y">
                  {chatCtx.messages.map(m => (
                    <div key={m.id} className={cn(
                      'px-3 py-1.5 text-xs',
                      m.id === current.messageId && 'bg-accent font-medium',
                    )}>
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-muted-foreground">
                          {formatTime(m.timestamp)}
                        </span>
                        {(m.badges as string[]).length > 0 && (
                          <span className="text-muted-foreground">{(m.badges as string[]).join('+')}</span>
                        )}
                        {(m.symbols as string[]).length > 0 && (
                          <span className="font-mono text-[10px]">{(m.symbols as string[]).join(' ')}</span>
                        )}
                      </div>
                      <p className={cn('leading-relaxed', m.id !== current.messageId && 'text-muted-foreground')}>
                        {m.cleanText.slice(0, 200)}{m.cleanText.length > 200 ? '...' : ''}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Bottom bar */}
      <div className="shrink-0 border-t bg-card px-4 py-2">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="xs" onClick={() => nav.go(-1)} disabled={nav.currentIdx === 0} className="text-muted-foreground disabled:opacity-20">
              <Kbd>↑</Kbd>
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">{nav.currentIdx + 1}/{nav.total}</span>
            <Button variant="ghost" size="xs" onClick={() => nav.go(1)} disabled={nav.currentIdx >= nav.total - 1} className="text-muted-foreground disabled:opacity-20">
              <Kbd>↓</Kbd>
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            {lastReviewedId && (
              <Button variant="outline" size="xs" onClick={undo} disabled={undoMut.isPending}
                className="text-muted-foreground mr-1">
                <Kbd>z</Kbd> <span>Undo</span>
              </Button>
            )}
            {editMode ? (
              <>
                <Button variant="outline" size="xs" onClick={() => { setEditMode(false); setEditLabel(null); }}>
                  <Kbd>esc</Kbd> <span>Cancel</span>
                </Button>
                <Button variant="default" size="xs" onClick={submitEdit} disabled={reviewMut.isPending}>
                  <Kbd>s</Kbd> <span>Save Correction</span>
                </Button>
              </>
            ) : (
              <>
                <ActionButton label="Approve" kbd="a" onClick={approve} disabled={approveMut.isPending} variant="positive" />
                <ActionButton label="Edit" kbd="e" onClick={enterEdit} disabled={false} variant="caution" />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Signal Display ──────────────────────────────────────────────────────────

function SignalDisplay({ signal, index, total }: { signal: Signal; index: number; total: number }) {
  return (
    <div className={cn(total > 1 && 'pt-2', index > 0 && 'border-t mt-2')}>
      {total > 1 && (
        <p className="text-[10px] font-medium text-muted-foreground mb-1.5">Signal {index + 1}</p>
      )}
      <div className="flex items-center gap-3 mb-1">
        <LabelField label="action" value={signal.action} />
        {signal.direction && <LabelField label="dir" value={signal.direction} />}
        {signal.symbol && <LabelField label="sym" value={signal.symbol} />}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {signal.strategy && <LabelField label="strategy" value={signal.strategy} />}
        {signal.strikes && signal.strikes.length > 0 && <LabelField label="strikes" value={signal.strikes.join(', ')} />}
        {signal.expiry && <LabelField label="exp" value={signal.expiry} />}
        {signal.statedPrice != null && <LabelField label="price" value={String(signal.statedPrice)} />}
        {signal.quantity != null && <LabelField label="qty" value={String(signal.quantity)} />}
        {signal.exitPercent != null && <LabelField label="exit%" value={`${Math.round(signal.exitPercent * 100)}%`} />}
        {signal.targetStrategy && <LabelField label="target" value={signal.targetStrategy} />}
      </div>
    </div>
  );
}

// ── Label Display ───────────────────────────────────────────────────────────

function LabelDisplay({ label, title }: { label: EvalLabel; title: string }) {
  const trades = label.trades ?? [];
  const totalSignals = trades.reduce((sum, trade) => sum + trade.length, 0);
  return (
    <div className="rounded-md border px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">{title}</p>

      {/* Core classification */}
      <div className="flex items-center gap-3 mb-2">
        <LabelField label="isTrade" value={label.isTrade ? 'YES' : 'NO'} highlight={label.isTrade} />
        {trades.length > 1 && (
          <span className="text-xs bg-blue-500/10 text-blue-500 px-1.5 py-0.5 rounded font-medium">
            {trades.length} trades
          </span>
        )}
        {trades.length === 1 && totalSignals > 1 && (
          <span className="text-xs bg-blue-500/10 text-blue-500 px-1.5 py-0.5 rounded font-medium">
            {totalSignals} signals
          </span>
        )}
        <span className="ml-auto">
          <ConfidenceDot confidence={label.confidence} showLabel />
        </span>
      </div>

      {/* Trades */}
      {label.isTrade && trades.length > 0 && (
        <div className="mb-2 space-y-3">
          {trades.map((legs, ti) => (
            <div key={ti} className={cn(trades.length > 1 && 'border rounded-md px-2.5 py-2')}>
              {trades.length > 1 && (
                <p className="text-[10px] font-medium text-muted-foreground mb-1.5">Trade {ti + 1}</p>
              )}
              {legs.map((signal, li) => (
                <SignalDisplay key={li} signal={signal} index={li} total={legs.length} />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Reasoning */}
      {label.reasoning && (
        <p className="text-xs text-muted-foreground leading-relaxed mt-1">{label.reasoning}</p>
      )}
    </div>
  );
}

// ── Signal Editor ───────────────────────────────────────────────────────────

const SIGNAL_ACTIONS: Signal['action'][] = ['OPEN', 'CLOSE', 'ADD', 'TRIM', 'LEG_OFF'];
const SIGNAL_STRATEGIES = ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'PCS', 'CCS'] as const;

function SignalEditor({ signal, index, total, onChange, onRemove }: {
  signal: KeyedSignal;
  index: number;
  total: number;
  onChange: (s: KeyedSignal) => void;
  onRemove: (() => void) | null;
}) {
  const update = <K extends keyof Signal>(key: K, value: Signal[K]) => {
    onChange({ ...signal, [key]: value } as KeyedSignal);
  };

  return (
    <div className={cn(index > 0 && 'border-t pt-3 mt-3')}>
      <div className="flex items-center justify-between mb-2">
        {total > 1 && (
          <p className="text-[10px] font-medium text-muted-foreground">Signal {index + 1}</p>
        )}
        {total === 1 && <div />}
        {onRemove && (
          <Button variant="ghost" size="xs" onClick={onRemove} className="text-loss hover:text-loss hover:bg-loss/10 h-5 text-[10px]">
            Remove
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
        {/* action */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">action</span>
          <ToggleGroup type="single" variant="outline" size="sm"
            value={signal.action}
            onValueChange={v => { if (v) update('action', v as Signal['action']); }}
            className="h-6 flex-wrap justify-start"
          >
            {SIGNAL_ACTIONS.map((action) => (
              <ToggleGroupItem key={action} value={action} className="text-xs h-6 px-2">
                {action}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        {/* symbol */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">symbol</span>
          <Input
            type="text"
            value={signal.symbol}
            onChange={e => update('symbol', e.target.value.toUpperCase())}
            className="flex-1 h-6 px-1.5 py-0.5 text-xs"
            placeholder="e.g. SPY"
          />
        </div>

        {/* direction */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">direction</span>
          <ToggleGroup type="single" variant="outline" size="sm"
            value={signal.direction ?? '---'}
            onValueChange={v => { if (v) update('direction', v === '---' ? null : v as Signal['direction']); }}
            className="h-6"
          >
            <ToggleGroupItem value="LONG" className="text-xs h-6 px-2">LONG</ToggleGroupItem>
            <ToggleGroupItem value="SHORT" className="text-xs h-6 px-2">SHORT</ToggleGroupItem>
            <ToggleGroupItem value="---" className="text-xs h-6 px-2">---</ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* strategy */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">strategy</span>
          <ToggleGroup type="single" variant="outline" size="sm"
            value={signal.strategy ?? '---'}
            onValueChange={v => { if (v) update('strategy', v === '---' ? null : v as Signal['strategy']); }}
            className="h-6 flex-wrap justify-start"
          >
            {SIGNAL_STRATEGIES.map((strategy) => (
              <ToggleGroupItem key={strategy} value={strategy} className="text-xs h-6 px-2">
                {strategy}
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value="---" className="text-xs h-6 px-2">---</ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* strikes */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">strikes</span>
          <Input
            type="text"
            value={signal.strikes?.join(', ') ?? ''}
            onChange={e => {
              const val = e.target.value;
              if (!val.trim()) { update('strikes', null); return; }
              const nums = val.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
              update('strikes', nums.length > 0 ? nums : null);
            }}
            className="flex-1 h-6 px-1.5 py-0.5 text-xs"
            placeholder="e.g. 450, 460"
          />
        </div>

        {/* expiry */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">expiry</span>
          <Input
            type="text"
            value={signal.expiry ?? ''}
            onChange={e => update('expiry', e.target.value || null)}
            className="flex-1 h-6 px-1.5 py-0.5 text-xs"
            placeholder="e.g. 5/23 or Oct (17)"
          />
        </div>

        {/* price */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">price</span>
          <Input
            type="number"
            step="0.01"
            value={signal.statedPrice ?? ''}
            onChange={e => update('statedPrice', e.target.value ? parseFloat(e.target.value) : null)}
            className="flex-1 h-6 px-1.5 py-0.5 text-xs"
            placeholder="e.g. 2.50"
          />
        </div>

        {/* quantity */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">qty</span>
          <Input
            type="number"
            step="1"
            value={signal.quantity ?? ''}
            onChange={e => update('quantity', e.target.value ? parseInt(e.target.value, 10) : null)}
            className="flex-1 h-6 px-1.5 py-0.5 text-xs"
            placeholder="e.g. 10"
          />
        </div>

        {/* exitPercent */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">exit%</span>
          <Input
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={signal.exitPercent ?? ''}
            onChange={e => update('exitPercent', e.target.value ? parseFloat(e.target.value) : undefined)}
            className="flex-1 h-6 px-1.5 py-0.5 text-xs"
            placeholder="e.g. 0.5"
          />
        </div>

        {/* targetStrategy */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-16">target</span>
          <ToggleGroup type="single" variant="outline" size="sm"
            value={signal.targetStrategy ?? '---'}
            onValueChange={v => { if (v) update('targetStrategy', v === '---' ? undefined : v as Signal['targetStrategy']); }}
            className="h-6 flex-wrap justify-start"
          >
            {SIGNAL_STRATEGIES.map((strategy) => (
              <ToggleGroupItem key={strategy} value={strategy} className="text-xs h-6 px-2">
                {strategy}
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value="---" className="text-xs h-6 px-2">---</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
    </div>
  );
}

// ── Label Editor ────────────────────────────────────────────────────────────

type EditLabel = Omit<EvalLabel, 'trades'> & { trades: KeyedTrade[] };

function TradeEditor({ trade, index, total, onChange, onRemove }: {
  trade: KeyedTrade;
  index: number;
  total: number;
  onChange: (trade: KeyedTrade) => void;
  onRemove: (() => void) | null;
}) {
  const signals = trade.signals;

  const updateSignal = (signalIndex: number, updated: KeyedSignal) => {
    const nextSignals = [...signals];
    nextSignals[signalIndex] = updated;
    onChange({ ...trade, signals: nextSignals });
  };

  const removeSignal = (signalIndex: number) => {
    onChange({ ...trade, signals: signals.filter((_, i) => i !== signalIndex) });
  };

  const addSignal = () => {
    onChange({ ...trade, signals: [...signals, emptySignal()] });
  };

  return (
    <div className={cn('rounded-md border px-3 py-2.5', index > 0 && 'mt-3')}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {total > 1 ? `Trade ${index + 1}` : 'Trade'}
        </p>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="xs" onClick={addSignal} className="text-xs">
            + Add Signal
          </Button>
          {onRemove && (
            <Button variant="ghost" size="xs" onClick={onRemove} className="text-loss hover:text-loss hover:bg-loss/10">
              Remove Trade
            </Button>
          )}
        </div>
      </div>

      {signals.map((signal, signalIndex) => (
        <SignalEditor
          key={signal._id}
          signal={signal}
          index={signalIndex}
          total={signals.length}
          onChange={(updated) => updateSignal(signalIndex, updated)}
          onRemove={signals.length > 1 ? () => removeSignal(signalIndex) : null}
        />
      ))}
    </div>
  );
}

function LabelEditor({ label, onChange }: { label: EditLabel; onChange: (l: EditLabel) => void }) {
  const trades = label.trades ?? [];

  const updateTrade = (index: number, updated: KeyedTrade) => {
    const nextTrades = [...trades];
    nextTrades[index] = updated;
    onChange({ ...label, trades: nextTrades });
  };

  const removeTrade = (index: number) => {
    onChange({ ...label, trades: trades.filter((_, i) => i !== index) });
  };

  const addTrade = () => {
    onChange({ ...label, trades: [...trades, emptyTrade()] });
  };

  const toggleIsTrade = (value: boolean) => {
    if (value) {
      const nextTrades = trades.length === 0 ? [emptyTrade()] : trades;
      onChange({ ...label, isTrade: true, trades: nextTrades });
    } else {
      onChange({ ...label, isTrade: false, trades: [] });
    }
  };

  return (
    <div className="rounded-md border border-warning/40 px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-warning mb-2">Edit Label</p>

      <div className="space-y-3">
        {/* Top-level fields */}
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-16">isTrade</span>
            <ToggleGroup type="single" variant="outline" size="sm"
              value={label.isTrade ? 'YES' : 'NO'}
              onValueChange={v => { if (v) toggleIsTrade(v === 'YES'); }}
              className="h-6"
            >
              <ToggleGroupItem value="YES" className="text-xs h-6 px-2">YES</ToggleGroupItem>
              <ToggleGroupItem value="NO" className="text-xs h-6 px-2">NO</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">confidence</span>
            <ToggleGroup type="single" variant="outline" size="sm"
              value={label.confidence}
              onValueChange={v => { if (v) onChange({ ...label, confidence: v as 'HIGH' | 'LOW' }); }}
              className="h-6"
            >
              <ToggleGroupItem value="HIGH" className="text-xs h-6 px-2">HIGH</ToggleGroupItem>
              <ToggleGroupItem value="LOW" className="text-xs h-6 px-2">LOW</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        {/* Signals */}
        {label.isTrade && (
          <div>
            {trades.map((trade, index) => (
              <TradeEditor
                key={trade._id}
                trade={trade}
                index={index}
                total={trades.length}
                onChange={(updated) => updateTrade(index, updated)}
                onRemove={trades.length > 1 ? () => removeTrade(index) : null}
              />
            ))}
            <div className="mt-3">
              <Button variant="outline" size="xs" onClick={addTrade} className="text-xs">
                + Add Trade
              </Button>
            </div>
          </div>
        )}

        {/* Reasoning (read-only context) */}
        {label.reasoning && (
          <p className="text-xs text-muted-foreground leading-relaxed italic">{label.reasoning}</p>
        )}
      </div>
    </div>
  );
}

// ── Small Components ────────────────────────────────────────────────────────

function LabelField({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <span className="text-sm">
      <span className="text-muted-foreground text-[10px] mr-0.5">{label}</span>{' '}
      <span className={cn('font-medium', highlight && 'text-profit')}>{value}</span>
    </span>
  );
}

function ConfidenceDot({ confidence, showLabel }: { confidence: string; showLabel?: boolean }) {
  const isLow = confidence === 'LOW';
  return (
    <span className={cn(
      'inline-flex items-center gap-1 text-[10px] font-medium',
      isLow ? 'text-warning' : 'text-muted-foreground',
    )}>
      <span className={cn('w-1.5 h-1.5 rounded-full', isLow ? 'bg-warning' : 'bg-muted-foreground/40')} />
      {showLabel && confidence}
    </span>
  );
}

function ActionButton({ label, kbd, onClick, disabled, variant }: {
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
    <Button variant="outline" size="xs" onClick={onClick} disabled={disabled}
      className={cn(styles[variant])}>
      <Kbd>{kbd}</Kbd>
      <span>{label}</span>
    </Button>
  );
}

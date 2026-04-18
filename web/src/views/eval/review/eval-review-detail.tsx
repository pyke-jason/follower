import { useEffect, useState, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ClipboardCheck, Ban } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatDate, formatTime } from '@/lib/format';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { useEvalNav } from '@/hooks/use-eval-nav';
import { Badge as AppBadge } from '@/components/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { LabelRow, EvalLabel, ChatContext } from './types';
import { REJECTION_REASONS } from './types';
import { LabelDisplay, LabelEditor, ActionButton, keyTrades, stripTrades } from './label-components';
import type { EditLabel } from './label-components';

// ── Detail Panel ────────────────────────────────────────────────────────────

export function EvalReviewDetail({ items, nav }: {
  items: LabelRow[];
  nav: ReturnType<typeof useEvalNav<LabelRow>>;
}) {
  const current = nav.current!;

  const { data: chatCtx } = useQuery<ChatContext>({
    queryKey: ['eval-context', current.id],
    queryFn: () => api<ChatContext>(`/eval/labels/${current.id}/context`),
    enabled: !!current,
  });

  type Mode = 'view' | 'edit' | 'reject';
  const [mode, setMode] = useState<Mode>('view');
  const [editLabel, setEditLabel] = useState<EditLabel | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectFeedback, setRejectFeedback] = useState('');
  const [lastReviewedId, setLastReviewedId] = useState<string | null>(null);
  const rejectTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset inline when the active item changes — not via useEffect (avoids a
  // render pass with stale state) and not via key= on this subtree (which would
  // remount the chatCtx query). See web-components.md §React Performance.
  const lastIdRef = useRef(current.id);
  if (lastIdRef.current !== current.id) {
    lastIdRef.current = current.id;
    setMode('view');
    setEditLabel(null);
    setRejectReason('');
    setRejectFeedback('');
  }

  // Auto-focus textarea when entering reject mode
  useEffect(() => {
    if (mode === 'reject') {
      requestAnimationFrame(() => rejectTextareaRef.current?.focus());
    }
  }, [mode]);

  // Approve mutation
  const approveMut = useApiMutation<{ id: string }>(
    'POST',
    (v) => `/eval/labels/${v.id}/approve`,
    {
      invalidate: [['eval-labels']],
      onSuccess: (_data, vars) => {
        setLastReviewedId(vars.id);
        setMode('view');
        toast.success('Label approved');
        nav.goNextUnreviewed();
      },
    },
  );

  // Reject mutation
  const rejectMut = useApiMutation<{ id: string; reason: string; feedback?: string }>(
    'POST',
    (v) => `/eval/labels/${v.id}/reject`,
    {
      body: (v) => ({ reason: v.reason, feedback: v.feedback }),
      invalidate: [['eval-labels']],
      onSuccess: (_data, vars) => {
        setLastReviewedId(vars.id);
        setMode('view');
        setRejectReason('');
        setRejectFeedback('');
        toast.success('Label rejected');
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
        setMode('view');
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

  const submitReject = useCallback(() => {
    if (!rejectReason || rejectMut.isPending) return;
    rejectMut.mutate({ id: current.id, reason: rejectReason, feedback: rejectFeedback || undefined });
  }, [current, rejectReason, rejectFeedback, rejectMut]);

  const undo = useCallback(() => {
    if (!lastReviewedId || undoMut.isPending) return;
    undoMut.mutate({ id: lastReviewedId });
  }, [lastReviewedId, undoMut]);

  const submitEdit = useCallback(() => {
    if (!editLabel || reviewMut.isPending) return;
    const cleaned: EvalLabel = { ...editLabel, trades: stripTrades(editLabel.trades) };
    reviewMut.mutate({ id: current.id, humanLabel: cleaned });
  }, [current, editLabel, reviewMut]);

  const enterEdit = useCallback(() => {
    setEditLabel({ ...current.label, trades: keyTrades(current.label.trades ?? []) });
    setMode('edit');
  }, [current]);

  const enterReject = useCallback(() => {
    setMode('reject');
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const tag = target?.tagName;
      const isInputFocused = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable === true;

      // Cmd/Ctrl+Enter to submit in edit or reject mode (works even in inputs)
      if (mode !== 'view' && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (mode === 'edit') submitEdit();
        else if (mode === 'reject') submitReject();
        return;
      }

      if (isInputFocused) {
        if (e.key === 'Escape') target?.blur();
        return;
      }

      if (mode !== 'view' && e.key === 'Escape') {
        e.preventDefault();
        setMode('view');
        setEditLabel(null);
        setRejectReason('');
        setRejectFeedback('');
        return;
      }

      if (mode === 'edit' && e.key === 's') {
        e.preventDefault();
        submitEdit();
        return;
      }

      // Number keys in reject mode pick reason and submit (textarea already handled above)
      if (mode === 'reject' && e.key >= '1' && e.key <= String(REJECTION_REASONS.length)) {
        e.preventDefault();
        const reason = REJECTION_REASONS[parseInt(e.key, 10) - 1];
        if (reason) {
          rejectMut.mutate({ id: current.id, reason: reason.value, feedback: rejectFeedback || undefined });
        }
        return;
      }

      if (mode === 'view') {
        switch (e.key) {
          case 'a': e.preventDefault(); approve(); break;
          case 'r': e.preventDefault(); enterReject(); break;
          case 'e': e.preventDefault(); enterEdit(); break;
          case 'z': e.preventDefault(); undo(); break;
          case 'ArrowDown': e.preventDefault(); nav.go(1); break;
          case 'ArrowUp': e.preventDefault(); nav.go(-1); break;
          case 'Escape': e.preventDefault(); nav.goTo(''); break;
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [approve, undo, nav, mode, enterEdit, enterReject, submitEdit, submitReject]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <ScrollArea className="flex-1">
        <div>
          <div className="max-w-2xl mx-auto py-5 px-5">
            {/* Header */}
            <div className="flex items-center gap-2 mb-1 text-sm">
              <span className="font-medium">{current.author}</span>
              <span className="text-muted-foreground text-xs">{formatDate(current.timestamp)}</span>
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
            {mode === 'edit' ? (
              <LabelEditor label={editLabel!} onChange={setEditLabel} />
            ) : (
              <LabelDisplay label={current.label} title="Agent Label" />
            )}

            {/* Reject form */}
            {mode === 'reject' && (
              <div className="mt-3 rounded-md border border-loss/30 bg-loss/5 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-loss mb-2">Reject</p>
                <Textarea
                  ref={rejectTextareaRef}
                  value={rejectFeedback}
                  onChange={e => setRejectFeedback(e.target.value)}
                  placeholder="Optional feedback for the agent..."
                  className="text-xs min-h-[60px] resize-none mb-2"
                />
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={rejectReason}
                  onValueChange={v => {
                    if (!v) return;
                    // Clicking a pill picks reason and submits immediately
                    rejectMut.mutate({ id: current.id, reason: v, feedback: rejectFeedback || undefined });
                  }}
                  className="flex-wrap justify-start"
                >
                  {REJECTION_REASONS.map((r, i) => (
                    <ToggleGroupItem key={r.value} value={r.value} className="text-xs h-7 px-2.5">
                      <Kbd className="opacity-50">{i + 1}</Kbd> {r.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            )}

            {/* Human review status (if already reviewed, not in edit/reject mode) */}
            {current.humanVerified && mode === 'view' && (
              <div className="mt-3">
                {current.rejectionReason ? (
                  <div className="text-xs text-loss flex items-start gap-1.5 px-3 py-2 bg-loss/5 rounded-md border border-loss/20">
                    <Ban className="size-3.5 mt-0.5 shrink-0" />
                    <div>
                      <span className="font-medium">Rejected:</span> {REJECTION_REASONS.find(r => r.value === current.rejectionReason)?.label ?? current.rejectionReason}
                      {current.feedback && <p className="text-muted-foreground mt-0.5">{current.feedback}</p>}
                    </div>
                  </div>
                ) : current.humanLabel ? (
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
                        <span className="text-muted-foreground">{formatTime(m.timestamp)}</span>
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
              <Kbd>{'↑'}</Kbd>
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">{nav.currentIdx + 1}/{nav.total}</span>
            <Button variant="ghost" size="xs" onClick={() => nav.go(1)} disabled={nav.currentIdx >= nav.total - 1} className="text-muted-foreground disabled:opacity-20">
              <Kbd>{'↓'}</Kbd>
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            {lastReviewedId && (
              <Button variant="outline" size="xs" onClick={undo} disabled={undoMut.isPending}
                className="text-muted-foreground mr-1">
                <Kbd>z</Kbd> <span>Undo</span>
              </Button>
            )}
            {mode === 'edit' ? (
              <>
                <Button variant="outline" size="xs" onClick={() => { setMode('view'); setEditLabel(null); }}>
                  <Kbd>esc</Kbd> <span>Cancel</span>
                </Button>
                <Button variant="default" size="xs" onClick={submitEdit} disabled={reviewMut.isPending}>
                  <Kbd>s</Kbd> <span>Save Correction</span>
                </Button>
              </>
            ) : mode === 'reject' ? (
              <>
                <Button variant="outline" size="xs" onClick={() => { setMode('view'); setRejectReason(''); setRejectFeedback(''); }}>
                  <Kbd>esc</Kbd> <span>Cancel</span>
                </Button>
                <Button variant="default" size="xs" onClick={submitReject} disabled={!rejectReason || rejectMut.isPending}
                  className="bg-loss hover:bg-loss/90 text-loss-foreground">
                  Submit Rejection
                </Button>
              </>
            ) : (
              <>
                <ActionButton label="Approve" kbd="a" onClick={approve} disabled={approveMut.isPending} variant="positive" />
                <ActionButton label="Reject" kbd="r" onClick={enterReject} disabled={false} variant="negative" />
                <ActionButton label="Edit" kbd="e" onClick={enterEdit} disabled={false} variant="caution" />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

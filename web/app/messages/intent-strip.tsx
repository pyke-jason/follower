'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/lib/utils';
import { Check, Pencil } from 'lucide-react';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import { approveIntent, type MessageIntent } from './actions';
import { LabelEditSheet } from './label-edit-sheet';
import type { Signal, MessageLabel } from '../../../src/db/schema';

const DECISION_STYLES: Record<string, string> = {
  EXECUTE:
    'bg-profit/10 text-profit dark:bg-profit/15',
  SKIP:
    'bg-muted text-muted-foreground/60',
  MANUAL_REVIEW:
    'bg-warning/10 text-warning dark:bg-warning/15',
};

const ACTION_LABEL: Record<string, string> = {
  OPEN: 'Open',
  CLOSE: 'Close',
  ADD: 'Add',
  TRIM: 'Trim',
};

function SignalPill({ signal }: { signal: Signal }) {
  const parts = [
    ACTION_LABEL[signal.action] ?? signal.action,
    signal.direction?.toLowerCase(),
    signal.symbol,
    signal.strategy,
  ].filter(Boolean);

  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-medium px-1.5 py-0.5 rounded bg-profit/10 text-profit dark:bg-profit/15">
      {parts.join(' ')}
    </span>
  );
}

function formatTokens(n: number | null) {
  if (n == null) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function IntentPopover({ intent }: { intent: MessageIntent }) {
  const inTok = formatTokens(intent.inputTokens);
  const outTok = formatTokens(intent.outputTokens);
  const dur = intent.durationMs != null ? `${(intent.durationMs / 1000).toFixed(1)}s` : null;

  return (
    <div className="space-y-2 text-xs max-w-sm">
      {intent.reasoning && (
        <p className="text-foreground/80 whitespace-pre-wrap leading-relaxed">
          {intent.reasoning}
        </p>
      )}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground pt-1 border-t border-border/50">
        <span className="font-mono">{intent.model}</span>
        <span>v{intent.version}</span>
        {dur && <span>{dur}</span>}
        {inTok && outTok && <span>{inTok}/{outTok} tok</span>}
      </div>
    </div>
  );
}

export function IntentStrip({
  intent,
  messageId,
  label,
}: {
  intent: MessageIntent;
  messageId: string;
  label?: MessageLabel;
}) {
  const signals = (intent.signals ?? []) as Signal[];
  const [editOpen, setEditOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isApproved = label?.reviewed === true;

  const handleApprove = () => {
    startTransition(async () => {
      await approveIntent(messageId, intent);
    });
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap ml-11 py-0.5">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex items-center text-[11px] font-medium px-1.5 py-0.5 rounded cursor-pointer',
              'hover:ring-1 hover:ring-inset hover:ring-current/20 transition-shadow',
              DECISION_STYLES[intent.decision] ?? DECISION_STYLES.SKIP,
            )}
          >
            {intent.decision}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80">
          <IntentPopover intent={intent} />
        </PopoverContent>
      </Popover>
      {signals.map((s, i) => (
        <SignalPill key={i} signal={s} />
      ))}
      {intent.decision === 'SKIP' && intent.reasoning && (
        <span className="text-[11px] text-muted-foreground/50 italic truncate max-w-xs">
          {intent.reasoning.length > 80
            ? intent.reasoning.slice(0, 77) + '...'
            : intent.reasoning}
        </span>
      )}

      {/* Label review buttons */}
      <div className="flex items-center gap-0.5 ml-auto">
        <button
          type="button"
          onClick={handleApprove}
          disabled={isPending}
          title={isApproved ? 'Label approved' : 'Approve intent as correct'}
          className={cn(
            'inline-flex items-center justify-center w-5 h-5 rounded transition-colors',
            isApproved
              ? 'text-profit bg-profit/15'
              : 'text-muted-foreground/40 hover:text-profit hover:bg-profit/10',
            isPending && 'opacity-50',
          )}
        >
          <Check className="w-3 h-3" strokeWidth={isApproved ? 3 : 2} />
        </button>
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          title="Edit label"
          className="inline-flex items-center justify-center w-5 h-5 rounded text-muted-foreground/40 hover:text-foreground hover:bg-accent transition-colors"
        >
          <Pencil className="w-3 h-3" />
        </button>
      </div>

      <LabelEditSheet
        messageId={messageId}
        intent={intent}
        label={label}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </div>
  );
}

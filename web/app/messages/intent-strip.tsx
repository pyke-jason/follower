'use client';

import { useState, useTransition, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Check, Plus } from 'lucide-react';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { saveLabel, approveIntent, type MessageIntent } from './actions';
import type { Signal, MessageLabel } from '../../../src/db/schema';

const DECISION_STYLES: Record<string, string> = {
  EXECUTE: 'bg-profit/10 text-profit dark:bg-profit/15',
  SKIP: 'bg-muted text-muted-foreground/60',
  MANUAL_REVIEW: 'bg-warning/10 text-warning dark:bg-warning/15',
};

const ACTION_LABEL: Record<string, string> = {
  OPEN: 'Open',
  CLOSE: 'Close',
  ADD: 'Add',
  TRIM: 'Trim',
};

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

function signalDisplayText(signal: Signal): string {
  const parts = [
    ACTION_LABEL[signal.action] ?? signal.action,
    signal.direction?.toLowerCase(),
    signal.symbol,
    signal.strategy,
  ].filter(Boolean);
  return parts.join(' ');
}

const BLANK_SIGNAL: Signal = {
  action: 'OPEN',
  symbol: '',
  direction: 'LONG',
  strategy: 'STOCK',
} as Signal;

const OPTIONS_STRATEGIES = ['CALL', 'PUT', 'CDS', 'PDS'];

// ─── Signal Edit Popover ──────────────────────────────

function SignalEditPopover({
  signal,
  open,
  onOpenChange,
  onUpdate,
  onRemove,
  children,
}: {
  signal: Signal;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: (updated: Signal) => void;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  const [draft, setDraft] = useState<Signal>(signal);

  // Reset draft when popover opens with new signal data
  const handleOpenChange = (next: boolean) => {
    if (next) setDraft(signal);
    onOpenChange(next);
  };

  const set = <K extends keyof Signal>(key: K, value: Signal[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const handleDone = () => {
    onUpdate(draft);
    onOpenChange(false);
  };

  const isOptions = OPTIONS_STRATEGIES.includes(draft.strategy);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-72 p-3 space-y-2">
        {/* Row 1: Action, Direction, Strategy */}
        <div className="grid grid-cols-3 gap-1.5">
          <Select value={draft.action} onValueChange={(v) => set('action', v as Signal['action'])}>
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="OPEN">OPEN</SelectItem>
              <SelectItem value="CLOSE">CLOSE</SelectItem>
              <SelectItem value="ADD">ADD</SelectItem>
              <SelectItem value="TRIM">TRIM</SelectItem>
            </SelectContent>
          </Select>
          <Select value={draft.direction} onValueChange={(v) => set('direction', v as Signal['direction'])}>
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="LONG">LONG</SelectItem>
              <SelectItem value="SHORT">SHORT</SelectItem>
            </SelectContent>
          </Select>
          <Select value={draft.strategy} onValueChange={(v) => set('strategy', v as Signal['strategy'])}>
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="STOCK">STOCK</SelectItem>
              <SelectItem value="CALL">CALL</SelectItem>
              <SelectItem value="PUT">PUT</SelectItem>
              <SelectItem value="CDS">CDS</SelectItem>
              <SelectItem value="PDS">PDS</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Row 2: Symbol, Price */}
        <div className="grid grid-cols-2 gap-1.5">
          <Input
            className="h-7 text-xs"
            placeholder="Symbol"
            value={draft.symbol}
            onChange={(e) => set('symbol', e.target.value.toUpperCase())}
          />
          <Input
            className="h-7 text-xs"
            placeholder="Price"
            type="number"
            step="0.01"
            value={draft.statedPremium ?? ''}
            onChange={(e) => set('statedPremium', e.target.value ? parseFloat(e.target.value) : undefined)}
          />
        </div>

        {/* Conditional: Options fields */}
        {isOptions && (
          <div className="grid grid-cols-2 gap-1.5">
            <Input
              className="h-7 text-xs"
              placeholder="Strikes (100, 110)"
              value={draft.legs?.map((l) => l.strike).join(', ') ?? ''}
              onChange={(e) => {
                const strikes = e.target.value
                  .split(',')
                  .map((s) => parseFloat(s.trim()))
                  .filter((n) => !isNaN(n));
                const existingLeg = draft.legs?.[0];
                set(
                  'legs',
                  strikes.map((strike) => ({
                    strike,
                    expiry: existingLeg?.expiry ?? '',
                    optionType: existingLeg?.optionType ?? (draft.strategy === 'PUT' || draft.strategy === 'PDS' ? 'PUT' : 'CALL'),
                    action: existingLeg?.action ?? 'BUY',
                  })),
                );
              }}
            />
            <Input
              className="h-7 text-xs"
              type="date"
              value={draft.legs?.[0]?.expiry ?? ''}
              onChange={(e) => {
                const expiry = e.target.value;
                set(
                  'legs',
                  (draft.legs ?? []).map((l) => ({ ...l, expiry })),
                );
              }}
            />
          </div>
        )}

        {/* Conditional: Exit % for TRIM */}
        {draft.action === 'TRIM' && (
          <Input
            className="h-7 text-xs w-24"
            placeholder="Exit % (0.5)"
            type="number"
            step="0.1"
            min="0"
            max="1"
            value={draft.exitPercent ?? ''}
            onChange={(e) => set('exitPercent', e.target.value ? parseFloat(e.target.value) : undefined)}
          />
        )}

        {/* Footer */}
        <div className="flex items-center pt-1 border-t border-border/50">
          <button
            type="button"
            onClick={onRemove}
            className="text-[11px] text-loss/70 hover:text-loss transition-colors"
          >
            Remove
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleDone}
            className="text-[11px] font-medium text-profit hover:text-profit/80 transition-colors"
          >
            Done
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Main IntentStrip ──────────────────────────────────

export function IntentStrip({
  intent,
  messageId,
  label,
}: {
  intent: MessageIntent;
  messageId: string;
  label?: MessageLabel;
}) {
  const intentSignals = (intent.signals ?? []) as Signal[];
  const labelSignals = (label?.signals ?? []) as Signal[];

  // Use label signals if label exists, otherwise intent signals
  const [editedSignals, setEditedSignals] = useState<Signal[]>(
    () => labelSignals.length > 0 || label?.reviewed ? labelSignals : intentSignals,
  );
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();
  const isApproved = label?.reviewed === true;

  // Check if signals have been edited from the initial state
  const sourceSignals = labelSignals.length > 0 || label?.reviewed ? labelSignals : intentSignals;
  const isDirty = JSON.stringify(editedSignals) !== JSON.stringify(sourceSignals);

  const handleUpdate = useCallback((index: number, updated: Signal) => {
    setEditedSignals((prev) => prev.map((s, i) => (i === index ? updated : s)));
  }, []);

  const handleRemove = useCallback((index: number) => {
    setEditedSignals((prev) => prev.filter((_, i) => i !== index));
    setOpenIndex(null);
  }, []);

  const handleAdd = useCallback(() => {
    setEditedSignals((prev) => [...prev, { ...BLANK_SIGNAL }]);
    setOpenIndex(editedSignals.length);
  }, [editedSignals.length]);

  const handleConfirm = () => {
    startTransition(async () => {
      if (!isDirty && !isApproved) {
        // No edits — just approve the intent signals as-is
        await approveIntent(messageId, intent);
      } else {
        // Save the edited signals
        await saveLabel(messageId, editedSignals, isDirty ? 'manual' : 'approved');
      }
    });
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap ml-11 py-0.5">
      {/* Decision badge with reasoning popover */}
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

      {/* Editable signal pills */}
      {editedSignals.map((signal, i) => (
        <SignalEditPopover
          key={i}
          signal={signal}
          open={openIndex === i}
          onOpenChange={(open) => setOpenIndex(open ? i : null)}
          onUpdate={(updated) => handleUpdate(i, updated)}
          onRemove={() => handleRemove(i)}
        >
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-0.5 text-[11px] font-medium px-1.5 py-0.5 rounded',
              'cursor-pointer transition-all',
              'bg-profit/10 text-profit dark:bg-profit/15',
              'hover:ring-1 hover:ring-inset hover:ring-profit/30',
              openIndex === i && 'ring-1 ring-inset ring-profit/40',
            )}
          >
            {signalDisplayText(signal)}
          </button>
        </SignalEditPopover>
      ))}

      {/* SKIP reasoning (when no signals) */}
      {editedSignals.length === 0 && intent.decision === 'SKIP' && intent.reasoning && (
        <span className="text-[11px] text-muted-foreground/50 italic truncate max-w-xs">
          {intent.reasoning.length > 80
            ? intent.reasoning.slice(0, 77) + '...'
            : intent.reasoning}
        </span>
      )}

      {/* Add signal button */}
      <button
        type="button"
        onClick={handleAdd}
        title="Add signal"
        className={cn(
          'inline-flex items-center justify-center w-5 h-5 rounded transition-colors',
          'text-muted-foreground/30 hover:text-foreground hover:bg-accent',
        )}
      >
        <Plus className="w-3 h-3" />
      </button>

      {/* Confirm / approve button */}
      <button
        type="button"
        onClick={handleConfirm}
        disabled={isPending}
        title={isApproved && !isDirty ? 'Label approved' : isDirty ? 'Save changes' : 'Approve intent'}
        className={cn(
          'inline-flex items-center justify-center w-5 h-5 rounded transition-colors',
          isApproved && !isDirty
            ? 'text-profit bg-profit/15'
            : isDirty
              ? 'text-profit bg-profit/10 ring-1 ring-profit/30'
              : 'text-muted-foreground/40 hover:text-profit hover:bg-profit/10',
          isPending && 'opacity-50',
        )}
      >
        <Check className="w-3 h-3" strokeWidth={isApproved && !isDirty ? 3 : 2} />
      </button>
    </div>
  );
}

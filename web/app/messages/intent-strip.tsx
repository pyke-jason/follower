import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import type { MessageIntent } from './actions';
import type { Signal } from '../../../src/db/schema';

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

export function IntentStrip({ intent }: { intent: MessageIntent }) {
  const signals = (intent.signals ?? []) as Signal[];

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
    </div>
  );
}

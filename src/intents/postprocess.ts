import type { Signal } from '../agent/schemas.js';

export type SignalContext = { cleanText: string; badges: string[]; symbols: string[] };
export type PostprocessFn = (signals: Signal[], ctx: SignalContext) => Signal[];

/**
 * If "leap" appears in message text, ensure OPEN signals carry a LEAP expiry leg.
 * When the LLM omits the LEAP expiry, inject a placeholder leg so downstream
 * `normalizeExpiry` resolves it to refDate + 1 year.
 */
export const leapExpiryFix: PostprocessFn = (signals, ctx) => {
  if (!/leap/i.test(ctx.cleanText)) return signals;
  return signals.map(sig => {
    if (sig.action !== 'OPEN') return sig;
    const hasLeapLeg = sig.legs?.some(l => /leap/i.test(l.expiry ?? ''));
    if (hasLeapLeg) return sig;
    return {
      ...sig,
      legs: [{
        action: 'BUY' as const,
        strike: 0,
        optionType: sig.strategy === 'PUT' ? 'PUT' as const : 'CALL' as const,
        expiry: 'LEAP',
      }],
    };
  });
};

/**
 * "Lotto" / "Yolo" = speculative BUY, always direction LONG.
 * Flip any SELL legs to BUY since these are never sell-to-open.
 */
export const lottoDirectionFix: PostprocessFn = (signals, ctx) => {
  if (!/\b(lotto|yolo)\b/i.test(ctx.cleanText)) return signals;
  return signals.map(sig => {
    if (sig.action !== 'OPEN') return sig;
    return {
      ...sig,
      direction: 'LONG' as const,
      legs: sig.legs?.map(l => ({
        ...l,
        action: l.action === 'SELL' ? 'BUY' as const : l.action,
      })),
    };
  });
};

/**
 * "wrote" / "writing" unambiguously means sell-to-open in options.
 * Force SHORT direction and flip BUY legs to SELL.
 *
 * "sold" is NOT included — "sold half my TSLA puts" is an exit, not sell-to-open.
 */
export const soldWroteDirectionFix: PostprocessFn = (signals, ctx) => {
  if (!/\b(wrote|writing)\b/i.test(ctx.cleanText)) return signals;
  return signals.map(sig => {
    if (sig.action !== 'OPEN') return sig;
    return {
      ...sig,
      direction: 'SHORT' as const,
      legs: sig.legs?.map(l => ({
        ...l,
        action: l.action === 'BUY' ? 'SELL' as const : l.action,
      })),
    };
  });
};

/**
 * For OPEN signals with no legs, scan cleanText for expiry hints and inject
 * a placeholder leg so downstream resolveSignalLegs can pick the right expiry
 * instead of defaulting to next Friday.
 */
export const expiryHintInjection: PostprocessFn = (signals, ctx) => {
  return signals.map(sig => {
    if (sig.action !== 'OPEN') return sig;
    if (sig.legs && sig.legs.length > 0) return sig;

    const text = ctx.cleanText;
    let matchedText: string | undefined;

    // Month + day: "jan 17", "Feb (3)", "mar(14)"
    const monthDay = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\(?\s*(\d{1,2})\s*\)?/i);
    if (monthDay) {
      matchedText = `${monthDay[1]} ${monthDay[2]}`;
    }

    // "next week", "next friday", etc.
    if (!matchedText) {
      const nextWeek = text.match(/\bnext\s+(week|friday|monday|tuesday|wednesday|thursday)\b/i);
      if (nextWeek) {
        matchedText = nextWeek[0];
      }
    }

    // Bare month: "jan", "feb" etc. without a day following
    if (!matchedText) {
      const bareMonth = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i);
      if (bareMonth) {
        matchedText = bareMonth[0];
      }
    }

    // "overnight" / "overnight hold" → next trading day (weekend-skipping).
    // Prevents 0DTE selection when a trader explicitly intends to hold past market close.
    if (!matchedText && /\bovernight\b/i.test(text)) {
      matchedText = 'overnight';
    }

    if (!matchedText) return sig;

    return {
      ...sig,
      legs: [{
        action: 'BUY' as const,
        strike: 0,
        optionType: sig.strategy === 'PUT' ? 'PUT' as const : 'CALL' as const,
        expiry: matchedText,
      }],
    };
  });
};

/** Chain post-processing functions left-to-right. */
export function composePostprocess(...fns: PostprocessFn[]): PostprocessFn {
  return (signals, ctx) => fns.reduce((sigs, fn) => fn(sigs, ctx), signals);
}

/** Identity — returns signals unchanged. */
export const noopPostprocess: PostprocessFn = (signals) => signals;

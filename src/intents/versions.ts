import type { Signal } from '../agent/schemas.js';
import type { PostprocessFn, SignalContext } from './postprocess.js';
import {
  noopPostprocess,
  composePostprocess,
  leapExpiryFix,
  lottoDirectionFix,
  soldWroteDirectionFix,
  expiryHintInjection,
} from './postprocess.js';
import {
  BASELINE_PROMPT,
  SOLD_WROTE_EXAMPLES,
  LOTTO_EXAMPLES,
  PCS_EXAMPLES,
  LEAP_BADGE_EXAMPLES,
  buildPromptWithExtraExamples,
  buildExamplesHeavyPrompt,
  buildMinimalRulesPrompt,
  buildCompactPrompt,
  buildExamplesFirstPrompt,
  buildBadgeTablePrompt,
} from './prompts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PreprocessResult = { decision: string; reasoning: string; signals: Signal[] };

export type IntentPipelineVersion = {
  id: number;
  name: string;
  description: string;
  systemPrompt: string;
  preprocess?: (ctx: SignalContext) => PreprocessResult | null;
  postprocess: PostprocessFn;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const compose = composePostprocess;
const allPostprocess = compose(leapExpiryFix, lottoDirectionFix, soldWroteDirectionFix, expiryHintInjection);

// ---------------------------------------------------------------------------
// Strangle preprocess
// ---------------------------------------------------------------------------

function stranglePreprocess(ctx: SignalContext): PreprocessResult | null {
  const hasStrangle = /strangle|straddle/i.test(ctx.cleanText);
  const hasLong = ctx.badges.includes('Long');
  const hasShort = ctx.badges.includes('Short');
  if (!hasStrangle || !hasLong || !hasShort) return null;
  const symbol = ctx.symbols[0];
  if (!symbol) return null;
  const hasExit = ctx.badges.includes('Exit');
  if (hasExit) {
    const exitIdx = ctx.badges.indexOf('Exit');
    const nextBadge = ctx.badges[exitIdx + 1];
    const strategy = nextBadge === 'Short' ? 'PUT' : 'CALL';
    return {
      decision: 'EXECUTE',
      reasoning: 'Deterministic strangle exit bypass',
      signals: [{ action: 'CLOSE', symbol, strategy, direction: 'LONG' } as Signal],
    };
  }
  return {
    decision: 'EXECUTE',
    reasoning: 'Deterministic strangle open bypass',
    signals: [
      { action: 'OPEN', symbol, direction: 'LONG', strategy: 'CALL' } as Signal,
      { action: 'OPEN', symbol, direction: 'LONG', strategy: 'PUT' } as Signal,
    ],
  };
}

// ---------------------------------------------------------------------------
// Version registry
// ---------------------------------------------------------------------------

export const VERSIONS: Record<string, IntentPipelineVersion> = {
  'v13-baseline': {
    id: 13,
    name: 'v13-baseline',
    description: 'Baseline prompt, no postprocessing',
    systemPrompt: BASELINE_PROMPT,
    postprocess: noopPostprocess,
  },
  'v14-postproc-direction': {
    id: 14,
    name: 'v14-postproc-direction',
    description: 'Baseline + lotto/wrote direction postprocessing',
    systemPrompt: BASELINE_PROMPT,
    postprocess: compose(lottoDirectionFix, soldWroteDirectionFix),
  },
  'v15-postproc-expiry': {
    id: 15,
    name: 'v15-postproc-expiry',
    description: 'Baseline + LEAP expiry fix + expiry hint injection',
    systemPrompt: BASELINE_PROMPT,
    postprocess: compose(leapExpiryFix, expiryHintInjection),
  },
  'v16-postproc-all': {
    id: 16,
    name: 'v16-postproc-all',
    description: 'Baseline + all 4 postprocessors',
    systemPrompt: BASELINE_PROMPT,
    postprocess: allPostprocess,
  },
  'v17-postproc-aggressive': {
    id: 17,
    name: 'v17-postproc-aggressive',
    description: 'Compact prompt + all 4 postprocessors',
    systemPrompt: buildCompactPrompt(),
    postprocess: allPostprocess,
  },
  'v18-examples-sold': {
    id: 18,
    name: 'v18-examples-sold',
    description: 'Baseline + extra sold/wrote examples',
    systemPrompt: buildPromptWithExtraExamples(BASELINE_PROMPT, SOLD_WROTE_EXAMPLES),
    postprocess: noopPostprocess,
  },
  'v19-examples-lotto': {
    id: 19,
    name: 'v19-examples-lotto',
    description: 'Baseline + extra lotto examples',
    systemPrompt: buildPromptWithExtraExamples(BASELINE_PROMPT, LOTTO_EXAMPLES),
    postprocess: noopPostprocess,
  },
  'v20-examples-pcs': {
    id: 20,
    name: 'v20-examples-pcs',
    description: 'Baseline + extra PCS examples',
    systemPrompt: buildPromptWithExtraExamples(BASELINE_PROMPT, PCS_EXAMPLES),
    postprocess: noopPostprocess,
  },
  'v21-examples-leap-badge': {
    id: 21,
    name: 'v21-examples-leap-badge',
    description: 'Baseline + extra LEAP badge examples',
    systemPrompt: buildPromptWithExtraExamples(BASELINE_PROMPT, LEAP_BADGE_EXAMPLES),
    postprocess: noopPostprocess,
  },
  'v22-examples-heavy': {
    id: 22,
    name: 'v22-examples-heavy',
    description: 'Baseline + all extra examples',
    systemPrompt: buildExamplesHeavyPrompt(),
    postprocess: noopPostprocess,
  },
  'v23-examples-heavy-postproc': {
    id: 23,
    name: 'v23-examples-heavy-postproc',
    description: 'All extra examples + all 4 postprocessors',
    systemPrompt: buildExamplesHeavyPrompt(),
    postprocess: allPostprocess,
  },
  'v24-no-rules': {
    id: 24,
    name: 'v24-no-rules',
    description: 'Stripped rules/direction/slang sections, examples compensate',
    systemPrompt: buildMinimalRulesPrompt(),
    postprocess: noopPostprocess,
  },
  'v25-examples-first': {
    id: 25,
    name: 'v25-examples-first',
    description: 'Baseline with examples moved after <process>',
    systemPrompt: buildExamplesFirstPrompt(),
    postprocess: noopPostprocess,
  },
  'v26-compact': {
    id: 26,
    name: 'v26-compact',
    description: 'Compact ~2000 token prompt, no postprocessing',
    systemPrompt: buildCompactPrompt(),
    postprocess: noopPostprocess,
  },
  'v27-badge-table': {
    id: 27,
    name: 'v27-badge-table',
    description: 'Baseline with badge->action mapping table',
    systemPrompt: buildBadgeTablePrompt(),
    postprocess: noopPostprocess,
  },
  'v28-best-examples-postproc': {
    id: 28,
    name: 'v28-best-examples-postproc',
    description: 'Best examples + all postprocessors (placeholder for best combo)',
    systemPrompt: buildExamplesHeavyPrompt(),
    postprocess: allPostprocess,
  },
  'v29-strangle-preprocess': {
    id: 29,
    name: 'v29-strangle-preprocess',
    description: 'Baseline + strangle deterministic preprocess',
    systemPrompt: BASELINE_PROMPT,
    preprocess: stranglePreprocess,
    postprocess: noopPostprocess,
  },
  'v30-full-pipeline': {
    id: 30,
    name: 'v30-full-pipeline',
    description: 'Heavy examples + all postprocessors + strangle preprocess',
    systemPrompt: buildExamplesHeavyPrompt(),
    preprocess: stranglePreprocess,
    postprocess: allPostprocess,
  },
  'v31-kitchen-sink': {
    id: 31,
    name: 'v31-kitchen-sink',
    description: 'Everything: heavy examples + all postprocessors + strangle preprocess',
    systemPrompt: buildExamplesHeavyPrompt(),
    preprocess: stranglePreprocess,
    postprocess: allPostprocess,
  },
};

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function getVersion(name: string): IntentPipelineVersion {
  const v = VERSIONS[name];
  if (!v) throw new Error(`Unknown intent version: "${name}". Available: ${listVersions().join(', ')}`);
  return v;
}

export function listVersions(): string[] {
  return Object.keys(VERSIONS);
}

// ---------------------------------------------------------------------------
// Default
// ---------------------------------------------------------------------------

export const DEFAULT_VERSION = VERSIONS['v30-full-pipeline'];

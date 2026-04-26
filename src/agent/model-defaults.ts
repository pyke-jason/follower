import type { ModelIdentity, ModelProvider } from './result.js';

export const TRADE_MODELS_BY_PROVIDER = {
  anthropic: [
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-6',
    'claude-opus-4-7',
  ],
  xai: [
    'grok-4-1-fast-reasoning',
    'grok-4-1-fast-non-reasoning',
  ],
} as const satisfies Record<ModelProvider, readonly string[]>;

export const DEFAULT_TRADE_MODEL = {
  provider: 'anthropic',
  model: 'claude-opus-4-7',
} as const satisfies ModelIdentity;

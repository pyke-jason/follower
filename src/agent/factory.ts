import type { Agent, ModelIdentity, ModelProvider } from './result.js';

let _defaultTradeModel: ModelIdentity | null = null;
export function getDefaultTradeModel(): ModelIdentity {
  if (!_defaultTradeModel) {
    _defaultTradeModel = {
      provider: (process.env.TRADE_MODEL_PROVIDER ?? 'anthropic') as ModelProvider,
      model: process.env.TRADE_MODEL ?? 'claude-sonnet-4-6',
    };
  }
  return _defaultTradeModel;
}

export async function createAgent(identity: ModelIdentity): Promise<Agent> {
  switch (identity.provider) {
    case 'anthropic': {
      const { AnthropicAgent } = await import('./anthropic-agent.js');
      return new AnthropicAgent(identity);
    }
    case 'xai': {
      const { XAIAgent } = await import('./xai-agent.js');
      return new XAIAgent(identity);
    }
    default: {
      const _exhaustive: never = identity.provider;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
}

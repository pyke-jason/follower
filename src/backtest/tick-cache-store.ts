import type { QuoteTick, ChainDefinition } from './databento-tape.js';

export interface TickCacheStore {
  readCachedRanges(dataset: string, dbnSchema: string, symbol: string): Promise<[number, number][]>;
  readCachedTicks(symbol: string, dbnSchema: string): Promise<QuoteTick[]>;
  writeCachedTicks(
    dataset: string,
    dbnSchema: string,
    symbol: string,
    ticks: QuoteTick[],
    range: [number, number],
  ): Promise<boolean>;
  loadCachedChain(dataset: string, parentSymbol: string, day: string): Promise<ChainDefinition[] | null>;
  saveCachedChain(
    dataset: string,
    parentSymbol: string,
    day: string,
    defs: ChainDefinition[],
  ): Promise<boolean>;
}

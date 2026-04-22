export function defaultTickSize(price: number): number {
  if (price < 3) return 0.05;
  return 0.1;
}

export function computeMidpoint(bid: number, ask: number, tickSize: number): number {
  const raw = (bid + ask) / 2;
  return Math.round(raw / tickSize) * tickSize;
}

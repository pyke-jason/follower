/**
 * Shared position reconstruction from labeled messages.
 *
 * Upgrades from binary OPEN/DELETE to quantity-tracking:
 *   OPEN  → set position, remainingPercent=1.0
 *   ADD   → update position (bump lastAction, record add context)
 *   TRIM  → reduce remainingPercent by exitPercent (default 0.5), delete if ≤0
 *   CLOSE → delete position
 *
 * Handles multiple labels per message in chronological order (e.g. CLOSE(CDS) + OPEN(CALL)
 * for leg adjustments).
 */

export type LabelRow = {
  action: string | null;
  direction: string | null;
  strategy: string | null;
  symbol: string | null;
  price: string | null;
  strikes: number[] | null;
  exitPercent: number | null;
  messageText: string;
  messageTimestamp: string;
};

export type ReconstructedPosition = {
  symbol: string;
  direction: string;
  strategy: string;
  action: string;
  price: string | null;
  strikes: number[] | null;
  remainingPercent: number;
  lastActionText: string;
  lastActionTimestamp: string;
  /** Original entry message text */
  entryText: string;
  entryTimestamp: string;
};

/**
 * Build a position key for deduplication.
 * Uses symbol:strategy:direction so that e.g. AAPL:CALL:LONG and AAPL:CDS:LONG are distinct.
 */
function positionKey(symbol: string, strategy: string, direction: string): string {
  return `${symbol}:${strategy}:${direction}`;
}

/**
 * Reconstruct open positions from a chronological stream of labels.
 * Labels MUST be sorted by message timestamp ascending.
 */
export function reconstructPositions(labels: LabelRow[]): ReconstructedPosition[] {
  const positions = new Map<string, ReconstructedPosition>();

  for (const label of labels) {
    const symbol = label.symbol ?? 'UNKNOWN';
    const strategy = label.strategy ?? 'UNKNOWN';
    const direction = label.direction ?? 'UNKNOWN';
    const key = positionKey(symbol, strategy, direction);

    switch (label.action) {
      case 'OPEN': {
        positions.set(key, {
          symbol,
          direction,
          strategy,
          action: 'OPEN',
          price: label.price,
          strikes: label.strikes,
          remainingPercent: 1.0,
          lastActionText: label.messageText,
          lastActionTimestamp: label.messageTimestamp,
          entryText: label.messageText,
          entryTimestamp: label.messageTimestamp,
        });
        break;
      }

      case 'ADD': {
        const existing = positions.get(key);
        if (existing) {
          // Update context — don't change remainingPercent (adds don't affect exit %)
          existing.action = 'ADD';
          existing.lastActionText = label.messageText;
          existing.lastActionTimestamp = label.messageTimestamp;
          // Update price to latest add price if provided
          if (label.price) existing.price = label.price;
        } else {
          // ADD without existing position — treat as OPEN
          positions.set(key, {
            symbol,
            direction,
            strategy,
            action: 'ADD',
            price: label.price,
            strikes: label.strikes,
            remainingPercent: 1.0,
            lastActionText: label.messageText,
            lastActionTimestamp: label.messageTimestamp,
            entryText: label.messageText,
            entryTimestamp: label.messageTimestamp,
          });
        }
        break;
      }

      case 'TRIM': {
        const existing = positions.get(key);
        if (existing) {
          const trimPercent = label.exitPercent ?? 0.5; // default to 50% if not specified
          existing.remainingPercent -= trimPercent;
          existing.action = 'TRIM';
          existing.lastActionText = label.messageText;
          existing.lastActionTimestamp = label.messageTimestamp;

          if (existing.remainingPercent <= 0.01) {
            // Effectively closed
            positions.delete(key);
          }
        }
        // TRIM without existing position — ignore (stale data)
        break;
      }

      case 'CLOSE': {
        // Full close — remove position
        positions.delete(key);

        // Also try fuzzy match: same symbol, any strategy/direction
        // This handles cases where strategy mutated (e.g. CDS → CALL)
        if (!positions.has(key)) {
          for (const [k, pos] of positions) {
            if (pos.symbol === symbol) {
              positions.delete(k);
              break; // only delete first match
            }
          }
        }
        break;
      }
    }
  }

  return Array.from(positions.values());
}

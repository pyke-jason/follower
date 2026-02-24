import { db, schema } from '../../../db/client.js';
import { eq } from 'drizzle-orm';
import type { EvalCase, EvalSource, ExpectedSignal } from '../types.js';
import type { Signal } from '../../../agent/schemas.js';

export function defaultMustMatch(signals: Signal[]): string[] {
  return signals.flatMap((s, i) => {
    const fields = [`signals[${i}].action`, `signals[${i}].symbol`];
    if (s.action === 'OPEN') {
      fields.push(`signals[${i}].direction`, `signals[${i}].strategy`);
    }
    if (s.action === 'TRIM' && s.exitPercent != null) {
      fields.push(`signals[${i}].exitPercent`);
    }
    if (s.action === 'LEG_OFF') {
      fields.push(`signals[${i}].targetStrategy`);
    }
    return fields;
  });
}

export class DbSource implements EvalSource {
  readonly name = 'db';

  async load(): Promise<EvalCase[]> {
    const rows = await db
      .select()
      .from(schema.messageLabels)
      .innerJoin(schema.messages, eq(schema.messageLabels.messageId, schema.messages.id))
      .where(eq(schema.messageLabels.reviewed, true));

    if (rows.length === 0) return [];

    return rows.map((row) => {
      const signals: Signal[] = row.message_labels.signals ?? [];
      const msg = row.messages;
      const label = row.message_labels;

      const expectedSignals: ExpectedSignal[] | undefined = signals.length > 0
        ? signals.map((s): ExpectedSignal => ({
            action: s.action as ExpectedSignal['action'],
            symbol: s.symbol,
            direction: s.direction,
            strategy: s.strategy,
            exitPercent: s.exitPercent,
            // targetStrategy on Signal is full StrategySchema; for LEG_OFF it's always CALL|PUT in practice
            targetStrategy: (s.targetStrategy === 'CALL' || s.targetStrategy === 'PUT')
              ? s.targetStrategy
              : undefined,
            statedPremium: s.statedPremium,
          }))
        : undefined;

      const evalCase: EvalCase = {
        id: `db-${label.id}`,
        description: label.notes ?? `DB label: ${msg.cleanText.slice(0, 60)}`,
        input: {
          message: msg.cleanText,
          author: msg.author,
          timestamp: msg.timestamp,
          badges: (msg.badges as string[] | null) ?? [],
          symbols: (msg.symbols as string[] | null) ?? [],
        },
        expected: {
          decision: signals.length > 0 ? 'EXECUTE' : 'SKIP',
          signals: expectedSignals,
        },
        mustMatch: defaultMustMatch(signals),
        tags: ['db', label.source === 'approved' ? 'approved' : 'manual'],
      };
      return evalCase;
    });
  }
}

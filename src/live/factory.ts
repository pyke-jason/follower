import { db, schema } from '../db/client.js';
import { isTrackedTrader } from '../config/traders.js';
import type { Message, TaskContext } from '../db/schema.js';
import { getDetectedStrategies } from '../db/accessors.js';
import { safeParseFloat } from '../lib/numbers.js';

const CONFIDENCE_THRESHOLD = 0.7;

export async function createTaskFromMessage(message: Message): Promise<string | null> {
  // Only create tasks for tracked traders
  if (!await isTrackedTrader(message.author)) {
    return null;
  }

  const badges = (message.badges as string[]) || [];
  const symbols = (message.symbols as string[]) || [];
  // Must have badges OR symbols to be tradable
  if (badges.length === 0 && symbols.length === 0) return null;

  if (message.isPaperTrade) return null;

  const confidence = safeParseFloat(message.confidence);

  // Badge-less messages always go to review (safety gate — no auto-execute without badges)
  const taskType = badges.length === 0
    ? 'REVIEW_MESSAGE' as const
    : (confidence >= CONFIDENCE_THRESHOLD ? 'EXECUTE_TRADE' : 'REVIEW_MESSAGE');

  const context: TaskContext = {
    messageId: message.id,
    messageTimestamp: message.timestamp,
    author: message.author,
    cleanText: message.cleanText,
    rawHtml: message.rawHtml,
    badges,
    symbols: (message.symbols as string[]) || [],
    actionHint: message.actionHint,
    directionHint: message.directionHint,
    detectedStrategies: getDetectedStrategies(message),
    confidence,
  };

  const [task] = await db.insert(schema.tasks).values({
    messageId: message.id,
    taskType,
    status: 'PENDING',
    assignee: 'agent',
    context,
  }).onConflictDoNothing().returning();

  if (!task) {
    console.log(`[Factory] Duplicate task skipped for message ${message.id}`);
    return null;
  }

  console.log(`[Factory] Created ${taskType} task ${task.id} for ${message.author} (confidence: ${confidence})`);
  return task.id;
}

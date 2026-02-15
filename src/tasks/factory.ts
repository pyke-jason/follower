import { db, schema } from '../db/client.js';
import { isTrackedTrader } from '../config/traders.js';
import type { Message, TaskContext } from '../db/schema.js';

const CONFIDENCE_THRESHOLD = 0.7;

export async function createTaskFromMessage(message: Message): Promise<string | null> {
  // Only create tasks for tracked traders
  if (!await isTrackedTrader(message.author)) {
    return null;
  }

  const badges = (message.badges as string[]) || [];
  if (badges.length === 0) return null;

  if (message.isPaperTrade) return null;

  const rawConfidence = message.confidence ? parseFloat(message.confidence) : 0;
  const confidence = Number.isNaN(rawConfidence) ? 0 : rawConfidence;

  const taskType = confidence >= CONFIDENCE_THRESHOLD ? 'EXECUTE_TRADE' : 'REVIEW_MESSAGE';

  const context: TaskContext = {
    messageId: message.id,
    author: message.author,
    cleanText: message.cleanText,
    badges,
    symbols: (message.symbols as string[]) || [],
    actionHint: message.actionHint,
    directionHint: message.directionHint,
    detectedStrategies: (message.detectedStrategies as any[]) || [],
    confidence,
  };

  const [task] = await db.insert(schema.tasks).values({
    messageId: message.id,
    taskType,
    status: 'PENDING',
    assignee: 'agent',
    context,
  }).returning();

  console.log(`[Factory] Created ${taskType} task ${task.id} for ${message.author} (confidence: ${confidence})`);
  return task.id;
}

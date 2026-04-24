import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult } from 'pg';
import type * as schema from './schema.js';

type AppDatabase = NodePgDatabase<typeof schema>;

type StartupMaintenanceStats = {
  orphanTradeEventsDeleted: number;
  orphanTradeTaskRefsCleared: number;
  orphanRunDecisionTaskRefsCleared: number;
  orphanRunDecisionTradeRefsCleared: number;
  orphanRunDecisionMessageRefsCleared: number;
};

async function runChanges(db: AppDatabase, statement: string): Promise<number> {
  const result = await db.execute(sql.raw(statement)) as QueryResult;
  return result.rowCount ?? 0;
}

async function hasAppTables(db: AppDatabase): Promise<boolean> {
  const result = await db.execute(sql`SELECT to_regclass('public.trades') AS table_name`) as QueryResult<{ table_name: string | null }>;
  return result.rows[0]?.table_name != null;
}

export async function runStartupMaintenance(db: AppDatabase): Promise<StartupMaintenanceStats> {
  if (!await hasAppTables(db)) {
    return {
      orphanTradeEventsDeleted: 0,
      orphanTradeTaskRefsCleared: 0,
      orphanRunDecisionTaskRefsCleared: 0,
      orphanRunDecisionTradeRefsCleared: 0,
      orphanRunDecisionMessageRefsCleared: 0,
    };
  }

  return {
    orphanTradeEventsDeleted: await runChanges(
      db,
      `
        DELETE FROM trade_events
        WHERE NOT EXISTS (
          SELECT 1
          FROM trades
          WHERE trades.id = trade_events.trade_id
        )
      `,
    ),
    orphanTradeTaskRefsCleared: await runChanges(
      db,
      `
        UPDATE trades
        SET task_id = NULL
        WHERE task_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM tasks
            WHERE tasks.id = trades.task_id
          )
      `,
    ),
    orphanRunDecisionTaskRefsCleared: await runChanges(
      db,
      `
        UPDATE run_decisions
        SET task_id = NULL
        WHERE task_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM tasks
            WHERE tasks.id = run_decisions.task_id
          )
      `,
    ),
    orphanRunDecisionTradeRefsCleared: await runChanges(
      db,
      `
        UPDATE run_decisions
        SET trade_id = NULL
        WHERE trade_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM trades
            WHERE trades.id = run_decisions.trade_id
          )
      `,
    ),
    orphanRunDecisionMessageRefsCleared: await runChanges(
      db,
      `
        UPDATE run_decisions
        SET message_id = NULL
        WHERE message_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM messages
            WHERE messages.id = run_decisions.message_id
          )
      `,
    ),
  };
}

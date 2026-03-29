import Database from 'better-sqlite3';

export type StartupMaintenanceStats = {
  orphanTradeEventsDeleted: number;
  orphanTradeTaskRefsCleared: number;
  orphanRunDecisionTaskRefsCleared: number;
  orphanRunDecisionTradeRefsCleared: number;
  orphanRunDecisionMessageRefsCleared: number;
};

function runChanges(sqlite: InstanceType<typeof Database>, statement: string): number {
  return sqlite.prepare(statement).run().changes;
}

export function runStartupMaintenance(sqlite: InstanceType<typeof Database>): StartupMaintenanceStats {
  return {
    orphanTradeEventsDeleted: runChanges(
      sqlite,
      `
        DELETE FROM trade_events
        WHERE NOT EXISTS (
          SELECT 1
          FROM trades
          WHERE trades.id = trade_events.trade_id
        )
      `,
    ),
    orphanTradeTaskRefsCleared: runChanges(
      sqlite,
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
    orphanRunDecisionTaskRefsCleared: runChanges(
      sqlite,
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
    orphanRunDecisionTradeRefsCleared: runChanges(
      sqlite,
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
    orphanRunDecisionMessageRefsCleared: runChanges(
      sqlite,
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

Problem:
All sim-broker DB and temporal tests (22 of 89) failed after recordTrade started emitting
to the trade_events table. The in-memory SQLite test databases only created the trades
table, so every closePositionAtPrice / forceCloseAll / sweepExpired call hit
"no such table: trade_events".

Decision:
Added a separate CREATE_TRADE_EVENTS_SQL export to test-fixtures.ts and wired it into
beforeAll() in all three DB-touching test files. Omitted the REFERENCES trades(id) FK
constraint from the test table to avoid cascade issues when resetDb() deletes trades.
Also updated resetDb() to DELETE FROM trade_events before trades.

Key Files:
- src/backtest/test-fixtures.ts  (CREATE_TRADE_EVENTS_SQL, resetDb)
- src/backtest/sim-broker-db.test.ts  (beforeAll)
- src/backtest/sim-broker-temporal.test.ts  (beforeAll)
- src/backtest/sim-broker.test.ts  (beforeAll, defensive)

Watch Out:
Any new table that recordTrade (or code it calls) writes to will need a matching
CREATE TABLE in test-fixtures.ts. The pattern is: export a CREATE_<TABLE>_SQL,
import it in each test file's beforeAll, and add a DELETE in resetDb(). Forgetting
the FK removal or the delete-order in resetDb will cause SQLITE_CONSTRAINT errors.

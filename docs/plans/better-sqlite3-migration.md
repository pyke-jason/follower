# Migration Plan: @libsql/client → better-sqlite3

## Problem Statement

The `@libsql/client` Sqlite3Client has a [known bug](https://github.com/tursodatabase/libsql-client-ts/issues/229) where `client.transaction()` sets its internal `#db` handle to `null` after `BEGIN IMMEDIATE`. Subsequent operations create a **new Database connection** that lacks our `PRAGMA busy_timeout=30000`. This causes `SQLITE_BUSY` errors on any brief write contention with other processes (e.g., web server vs. backtest subprocess), because the new connection has `busy_timeout=0` (no retry).

We currently work around this with `runTx()` (re-applies PRAGMAs after each transaction) and `withBusyRetry()` (jittered exponential backoff). These are band-aids. The proper fix is to switch to `better-sqlite3`, which uses a **single persistent connection** where PRAGMAs never get lost.

## Why better-sqlite3

| Concern | @libsql/client | better-sqlite3 |
|---------|----------------|----------------|
| Connection model | Drops `#db` → creates new connections | Single connection, never dropped |
| PRAGMA persistence | Lost after every `transaction()` | Persists for connection lifetime |
| busy_timeout | Must be re-applied manually | Set once via constructor or pragma |
| Turso remote sync | Supported (unused by us) | Not supported (not needed) |
| Native addon | No (pure JS wrapper over `libsql` addon) | Yes (native addon, prebuilt binaries) |
| Async transactions | "Works" (via separate connections) | **Does not work** — throws `"Transaction function cannot return a promise"` |

## Verified Findings

### Test 1: PRAGMA loss confirmed (libsql)
```
Before transaction: busy_timeout = 30000
After transaction:  busy_timeout = 0       ← BUG
After re-apply:     busy_timeout = 30000
```

### Test 2: better-sqlite3 rejects async transaction callbacks
```
Error: Transaction function cannot return a promise
```
This is a hard blocker for `db.transaction(async (tx) => { ... })`. All 14 of our transaction sites use async callbacks.

### Test 3: Manual BEGIN/COMMIT with async callbacks WORKS
```
✓ Both rows committed together
✓ Transaction rolled back correctly
✓ PRAGMAs persist across transactions
✓ Reads inside transaction see uncommitted writes
```
**Key insight:** With better-sqlite3's single connection, manual `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` on the raw `Database` instance + passing `db` as the tx object to async callbacks works perfectly. All drizzle operations route through the same connection, so they're all within the transaction regardless of `await` boundaries.

### Test 4: Drizzle API parity
```
db.run:     function  ✓
db.all:     function  ✓
db.get:     function  ✓
db.execute: undefined (not needed — use .run())
```
Drizzle's better-sqlite3 adapter exposes `.run()`, `.all()`, `.get()` on the db/tx objects — same as the libsql adapter.

---

## Migration Scope

### Dependencies

```diff
# package.json
- "@libsql/client": "^0.17.0",
+ "better-sqlite3": "^11.x",
+ "@types/better-sqlite3": "^7.x",  # devDependency
```

After migration, `libsql` (transitive dep of `@libsql/client`) is also removed.

**Native addon note:** `better-sqlite3` includes prebuilt binaries for macOS ARM64 (Apple Silicon), x64 Linux, and Windows. If prebuilds aren't available for your Node version, it falls back to compiling from source (requires Python + C++ toolchain). Current Node v20.x has prebuilds.

### Files to Change

| File | Change | Risk |
|------|--------|------|
| `src/db/client.ts` | Core rewrite — new driver, custom `runTx` | **HIGH** |
| `src/db/tick-cache-client.ts` | Same pattern as client.ts | **MED** |
| `src/db/migrate.ts` | Change migrator import + `.close()` | **LOW** |
| `src/db/seed.ts` | Change `.close()` call | **LOW** |
| `src/backtest/tick-cache-db.ts` | `LibSQLDatabase` → `BetterSQLite3Database` type | **LOW** |
| `src/backtest/test-fixtures.ts` | `db.run()` calls (already compatible) | **LOW** |
| `drizzle.config.ts` | Remove `url:` prefix handling | **LOW** |
| 6 test files (mocks) | Update `vi.mock` to use `better-sqlite3` | **MED** |

### Files NOT Changing

All business logic files (`record-trade.ts`, `emitter.ts`, `trade-flags.ts`, `fill-enrichment.ts`, `fill-sweep.ts`, `web-mutations.ts`, `runner.ts`, etc.) import `db`, `runTx`, `withBusyRetry` from `db/client.ts`. The abstraction boundary means they don't change.

---

## Implementation Steps

### Step 1: Install dependencies

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
npm uninstall @libsql/client
```

### Step 2: Rewrite `src/db/client.ts`

```typescript
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { PATHS } from '../lib/paths.js';

const dbPath = process.env.DATABASE_URL?.replace(/^file:/, '') ?? PATHS.db;

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 30000');

export const db = drizzle(sqlite, { schema });
export { schema };
export { sqlite as sqliteClient };

/**
 * Transaction wrapper using manual BEGIN/COMMIT on the raw Database instance.
 *
 * better-sqlite3's native `.transaction()` rejects async callbacks. Since our
 * callbacks are async (with `await` between drizzle operations), we manage the
 * transaction manually. This works because better-sqlite3 uses a single
 * connection — all operations route through it, staying within the transaction
 * regardless of microtask boundaries.
 *
 * Uses BEGIN IMMEDIATE to acquire the write lock upfront (prevents deadlocks
 * from deferred → write lock upgrades).
 */
export async function runTx<T>(
  cb: (tx: typeof db) => Promise<T>,
): Promise<T> {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = await cb(db);
    sqlite.exec('COMMIT');
    return result;
  } catch (err) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Retry wrapper for SQLITE_BUSY errors with jittered exponential backoff.
 *
 * With better-sqlite3 + busy_timeout=30000, SQLite handles contention
 * internally (waits up to 30s before throwing SQLITE_BUSY). This retry
 * wrapper is a safety net for edge cases where even 30s isn't enough
 * (e.g., long-running vacuum on another process).
 */
export async function withBusyRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const code = error?.code ?? error?.cause?.code;
      if (code === 'SQLITE_BUSY' && attempt < retries - 1) {
        const delay = Math.min(100 * Math.pow(2, attempt), 5000) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error('withBusyRetry: unreachable');
}
```

**Key differences from current code:**
- `reapplyPragmas()` is **deleted** — no longer needed (single connection)
- `runTx()` is simpler — no PRAGMA re-application, no `withBusyRetry` wrapper (busy_timeout works natively)
- `runTx()` passes `db` as the tx object — with single connection, this is safe
- `withBusyRetry()` is simplified to 3 retries (was 5) since busy_timeout already handles most cases
- Top-level `await` removed from initialization (better-sqlite3 is synchronous)

### Step 3: Rewrite `src/db/tick-cache-client.ts`

```typescript
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as tickCacheSchema from './tick-cache-schema.js';
import { PATHS } from '../lib/paths.js';

mkdirSync(dirname(PATHS.tickCacheDb), { recursive: true });

const sqlite = new Database(PATHS.tickCacheDb);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 30000');

// Hand-written DDL (not Drizzle-managed)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS quote_ticks (
    symbol TEXT NOT NULL,
    dbn_schema TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    bid REAL NOT NULL,
    ask REAL NOT NULL,
    open REAL,
    close REAL,
    volume INTEGER,
    PRIMARY KEY (symbol, dbn_schema, timestamp)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_qt_symbol_schema
    ON quote_ticks (symbol, dbn_schema);

  CREATE TABLE IF NOT EXISTS tick_cache_ranges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset TEXT NOT NULL,
    dbn_schema TEXT NOT NULL,
    symbol TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tcr_dataset_schema_symbol
    ON tick_cache_ranges (dataset, dbn_schema, symbol);

  CREATE TABLE IF NOT EXISTS chain_definitions (
    dataset TEXT NOT NULL,
    parent_symbol TEXT NOT NULL,
    day TEXT NOT NULL,
    raw_symbol TEXT NOT NULL,
    expiry TEXT NOT NULL,
    strike REAL NOT NULL,
    call_put TEXT NOT NULL,
    PRIMARY KEY (dataset, parent_symbol, day, raw_symbol)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_cd_dataset_parent_day
    ON chain_definitions (dataset, parent_symbol, day);

  CREATE TABLE IF NOT EXISTS chain_cache_meta (
    dataset TEXT NOT NULL,
    parent_symbol TEXT NOT NULL,
    day TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (dataset, parent_symbol, day)
  ) WITHOUT ROWID;
`);

export const tickCacheDb = drizzle(sqlite, { schema: tickCacheSchema });
export { tickCacheSchema };
export { sqlite as tickCacheSqliteClient };
```

### Step 4: Update `src/db/migrate.ts`

```diff
- import { migrate } from 'drizzle-orm/libsql/migrator';
+ import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
```

The rest (`db`, `sqliteClient.close()`) stays the same — better-sqlite3's `Database` has a `.close()` method.

### Step 5: Update `src/backtest/tick-cache-db.ts`

```diff
- import type { LibSQLDatabase } from 'drizzle-orm/libsql';
+ import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

- export type TickCacheDB = LibSQLDatabase<typeof tickCacheSchema>;
+ export type TickCacheDB = BetterSQLite3Database<typeof tickCacheSchema>;
```

### Step 6: Update `drizzle.config.ts`

```diff
  dbCredentials: {
-   url: process.env.DATABASE_URL ?? resolve(import.meta.dirname ?? '.', 'data/trade-follower.db'),
+   url: (process.env.DATABASE_URL?.replace(/^file:/, '') ?? resolve(import.meta.dirname ?? '.', 'data/trade-follower.db')),
  },
```

Note: `drizzle-kit` with `dialect: 'sqlite'` auto-detects which driver to use. If both `@libsql/client` and `better-sqlite3` are installed, it prefers `@libsql/client`. After uninstalling `@libsql/client`, it will use `better-sqlite3` automatically.

### Step 7: Update `runTx` call sites — change `tx` type

All `runTx` call sites currently use `tx` as a drizzle transaction object. With the new `runTx` passing `db` instead:

```diff
// record-trade.ts
- const trade = await runTx(async (tx) => {
-   await tx.insert(schema.trades).values(values);
+ const trade = await runTx(async (db) => {
+   await db.insert(schema.trades).values(values);
```

**However**, since `tx` and `db` are the same type (`BetterSQLite3Database`), the parameter name is cosmetic. No actual code changes are needed — `tx` still works fine because it IS the `db` object.

The `Tx` type alias in `record-trade.ts` needs updating:
```diff
- type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
+ type Tx = typeof db;
```

### Step 8: Update test mocks (6 files)

Each `vi.mock('../db/client.js', ...)` block changes from:
```typescript
vi.mock('../db/client.js', async () => {
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  const schema = await import('../db/schema.js');
  const client = createClient({ url: ':memory:' });
  const db = drizzle({ client, schema });
  return {
    db, schema, sqliteClient: client,
    runTx: (cb: any) => db.transaction(cb),
    withBusyRetry: (fn: any) => fn(),
    reapplyPragmas: async () => {},
  };
});
```

To:
```typescript
vi.mock('../db/client.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('../db/schema.js');
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  return {
    db, schema, sqliteClient: sqlite,
    runTx: async (cb: any) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await cb(db);
        sqlite.exec('COMMIT');
        return result;
      } catch (err) {
        if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
        throw err;
      }
    },
    withBusyRetry: (fn: any) => fn(),
  };
});
```

**Files:**
- `src/pipeline/build-deps.test.ts`
- `src/live/factory.test.ts`
- `src/backtest/sim-broker-db.test.ts`
- `src/backtest/sim-broker-pnl.test.ts`
- `src/backtest/sim-broker-temporal.test.ts`
- `src/backtest/sim-broker.test.ts`

### Step 9: Update `src/backtest/test-fixtures.ts`

The `db.run(sql\`DELETE FROM ...\`)` calls should work identically — drizzle's better-sqlite3 adapter has `.run()`.

### Step 10: Remove `reapplyPragmas` references

After the migration, `reapplyPragmas` no longer exists. Grep for any remaining references and remove them. The function is only used in `db/client.ts` (deleted) and test mocks (updated above).

---

## Verification Checklist

1. **`npm run db:migrate`** — migrations run with new driver
2. **`npx vitest run`** — all tests pass
3. **`npx tsc --noEmit`** — no type errors
4. **Concurrent write test** — start web server + run backtest simultaneously, confirm no SQLITE_BUSY
5. **PRAGMA persistence** — after running a backtest (which calls many `runTx`), verify `PRAGMA busy_timeout` still returns `30000`
6. **Backtest error handling** — force a failure mid-backtest, confirm it's marked FAILED in the DB

---

## Rollback Plan

If the migration fails or causes issues:
1. `npm install @libsql/client@0.17.0 && npm uninstall better-sqlite3 @types/better-sqlite3`
2. `git checkout -- src/db/client.ts src/db/tick-cache-client.ts src/db/migrate.ts`
3. The database files are unchanged (same SQLite format, same WAL mode)

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Native addon build fails on CI/deployment | better-sqlite3 ships prebuilds for Node 18/20/22 on macOS ARM64, Linux x64. Fallback: `npm rebuild` with C++ toolchain |
| `runTx` passes `db` instead of dedicated `tx` — operations outside the callback are also in the transaction | In our single-process architecture, this is safe. The backtest runner is sequential. The web server is a separate process with its own connection. |
| Nested `runTx` calls — inner `BEGIN IMMEDIATE` fails because outer tx is active | We have no nested transactions in the codebase. Add a guard (`sqlite.inTransaction`) if needed in the future |
| `db.transaction()` (drizzle's native) no longer works with async callbacks | We never call `db.transaction()` directly — all call sites use `runTx()`. Add a lint rule or comment to prevent future misuse |

---

## Sources

- [libsql client #229 — connection handle dropped after transaction](https://github.com/tursodatabase/libsql-client-ts/issues/229)
- [drizzle-orm #2275 — SQLite transactions can't be async](https://github.com/drizzle-team/drizzle-orm/issues/2275)
- [better-sqlite3 #1262 — async transaction callbacks not supported](https://github.com/WiseLibs/better-sqlite3/issues/1262)
- [@andyrmitchell/drizzle-robust-transaction](https://www.npmjs.com/package/@andyrmitchell/drizzle-robust-transaction)
- [SQLite busy_timeout best practices](https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/)
- [SQLite recommended PRAGMAs](https://highperformancesqlite.com/articles/sqlite-recommended-pragmas)
- [Drizzle ORM — SQLite getting started](https://orm.drizzle.team/docs/get-started-sqlite)
- [Drizzle ORM — Transactions](https://orm.drizzle.team/docs/transactions)

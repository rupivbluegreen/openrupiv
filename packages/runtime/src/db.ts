/**
 * Narrow database seam. Production wraps a `pg` Pool; unit tests inject a
 * fake implementing the same `Db`/`Queryable` interfaces (no live Postgres
 * in unit tests, per specs/phase-1-contracts.md §2 "Testing without Docker").
 */

import pg from "pg";

export interface QueryResultLike {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<QueryResultLike>;
}

export interface Db extends Queryable {
  /**
   * Run `fn` inside a transaction: BEGIN before, COMMIT on success,
   * ROLLBACK on any throw (the original error is rethrown).
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** Wrap a pg connection pool behind the narrow Db interface. */
export function createPgDb(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  return {
    async query(text, params = []) {
      const result = await pool.query(text, params as unknown[]);
      return { rows: result.rows, rowCount: result.rowCount };
    },

    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const tx: Queryable = {
        async query(text, params = []) {
          const result = await client.query(text, params as unknown[]);
          return { rows: result.rows, rowCount: result.rowCount };
        },
      };
      try {
        await client.query("BEGIN");
        const value = await fn(tx);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Connection-level failure during rollback: the original error
          // below is the actionable one; the client is discarded either way.
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async end() {
      await pool.end();
    },
  };
}

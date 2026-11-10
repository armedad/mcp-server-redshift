import { pool } from "../config/pool.js";

// Default number of rows a query returns, the same for everyone. A user can
// raise it for one query by asking in the prompt (the max_rows argument), up
// to the hard ceiling.
export const DEFAULT_MAX_ROWS = 1000;
export const MAX_ROWS_CEILING = 10000;

export class QueryInputError extends Error {}

export function resolveMaxRows(requested: unknown): number {
  if (requested === undefined || requested === null || requested === "") return DEFAULT_MAX_ROWS;
  const n = typeof requested === "string" ? parseInt(requested, 10) : requested;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new QueryInputError(
      `max_rows must be a whole number from 1 to ${MAX_ROWS_CEILING}. Omit it to use the default of ${DEFAULT_MAX_ROWS}.`
    );
  }
  if (n > MAX_ROWS_CEILING) {
    throw new QueryInputError(
      `max_rows ${n} is above the allowed maximum of ${MAX_ROWS_CEILING}. ` +
        "Ask for fewer rows, aggregate in SQL, or have the extension's maximum raised in its settings."
    );
  }
  return n;
}

// A single statement can be streamed through a cursor, so Redshift stops
// after max_rows + 1 rows instead of sending the whole result.
function singleStatement(sql: string): string | null {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  return trimmed.includes(";") ? null : trimmed;
}

export async function handleQuery(sql: string, maxRows: number) {
  const client = await pool.connect();
  try {
    // Start a read-only transaction
    await client.query("BEGIN TRANSACTION READ ONLY");

    let rows: Record<string, unknown>[] = [];
    let method = "cursor";
    const statement = singleStatement(sql);
    let cursorOpened = false;

    if (statement) {
      try {
        await client.query(`DECLARE mcp_capped_cursor CURSOR FOR ${statement}`);
        cursorOpened = true;
      } catch {
        // Not a cursor-able statement (for example SHOW or EXPLAIN): run it normally below.
        await client.query("ROLLBACK");
        await client.query("BEGIN TRANSACTION READ ONLY");
      }
    }

    if (cursorOpened) {
      const fetched = await client.query(`FETCH FORWARD ${maxRows + 1} FROM mcp_capped_cursor`);
      rows = fetched.rows;
    } else {
      method = "in-memory";
      const result: unknown = await client.query(sql);
      // A multi-statement query returns one result per statement; keep the last one with rows.
      const results = Array.isArray(result) ? result : [result];
      const withRows = results.filter((r: any) => Array.isArray(r?.rows) && r.fields?.length);
      rows = withRows.length > 0 ? (withRows[withRows.length - 1] as any).rows : [];
    }

    const truncated = rows.length > maxRows;
    return {
      rowCount: Math.min(rows.length, maxRows),
      maxRowsApplied: maxRows,
      truncated,
      ...(truncated && {
        note:
          `Stopped at ${maxRows} rows; the query has more. Aggregate or filter in SQL, or, only if the user ` +
          `explicitly asks for more rows, call query again with a higher max_rows (up to ${MAX_ROWS_CEILING}).`,
      }),
      ...(method === "in-memory" && { capMethod: "applied after the full result was fetched" }),
      rows: truncated ? rows.slice(0, maxRows) : rows,
    };
  } finally {
    // Always rollback the read-only transaction (this also closes the cursor)
    await client.query("ROLLBACK").catch((error: Error) =>
      console.error("Could not rollback the read-only transaction:", error)
    );
    client.release();
  }
}

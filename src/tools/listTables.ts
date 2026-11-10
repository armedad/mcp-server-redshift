import { pool } from "../config/pool.js";
import { config, parseSchemas } from "../config/database.js";

// Maximum rows returned in one call, so "all schemas" cannot flood the chat.
export const MAX_TABLES = 500;

export const SCHEMAS_FORMAT_HELP =
  'Pass schemas as an array of schema names, for example {"schemas": ["public"]} or ' +
  '{"schemas": ["sales", "marketing"]}. Omit it to use the configured default (all schemas when none is configured).';

export class ToolInputError extends Error {}

// Normalise the list_tables arguments. Accepts the documented form
// {"schemas": ["public"]} plus common variations ("schema" instead of
// "schemas", a single string, a comma-separated string, or a JSON-encoded
// array). Anything else is rejected with a message showing the right format,
// instead of silently falling back to every schema.
export function normalizeSchemasArg(args: Record<string, unknown> | undefined): string[] | undefined {
  const input = args ?? {};
  const unknown = Object.keys(input).filter((k) => k !== "schemas" && k !== "schema");
  if (unknown.length > 0) {
    throw new ToolInputError(`Unknown argument(s): ${unknown.join(", ")}. ${SCHEMAS_FORMAT_HELP}`);
  }

  const raw = input.schemas ?? input.schema;
  if (raw === undefined || raw === null) return undefined;

  let list: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text.startsWith("[")) {
      try {
        list = JSON.parse(text);
      } catch {
        throw new ToolInputError(`Could not read schemas value ${JSON.stringify(raw)}. ${SCHEMAS_FORMAT_HELP}`);
      }
    } else {
      list = text.split(",");
    }
  }

  if (!Array.isArray(list) || !list.every((s) => typeof s === "string")) {
    throw new ToolInputError(`Invalid schemas value ${JSON.stringify(raw)}. ${SCHEMAS_FORMAT_HELP}`);
  }
  const cleaned = (list as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

export async function handleListTables(schemas?: string[]) {
  // An explicit argument wins; otherwise fall back to the configured value.
  // A null list (blank, "*" or "all") means every non-system schema.
  const requested = schemas && schemas.length > 0 ? parseSchemas(schemas.join(",")) : config.schemas;
  const source = schemas && schemas.length > 0 ? "request" : "configured default";

  const params: string[] = [];
  let schemaFilter = "";
  if (requested) {
    const placeholders = requested.map((s, i) => {
      params.push(s);
      return `$${i + 1}`;
    });
    schemaFilter = `AND schema_name IN (${placeholders.join(",")})`;
  }

  const client = await pool.connect();
  try {
    // svv_all_tables covers local tables, views and external (Spectrum) tables.
    const result = await client.query(
      `
      SELECT
        schema_name AS schema,
        table_name AS name,
        table_type AS type,
        COALESCE(remarks, '') AS description
      FROM svv_all_tables
      WHERE database_name = current_database()
        AND schema_name NOT LIKE 'pg_%'
        AND schema_name NOT IN ('information_schema', 'catalog_history')
        ${schemaFilter}
      ORDER BY schema_name, table_name
      LIMIT ${MAX_TABLES + 1}
      `,
      params
    );

    const truncated = result.rows.length > MAX_TABLES;
    const tables = truncated ? result.rows.slice(0, MAX_TABLES) : result.rows;
    const foundSchemas = new Set(tables.map((r: { schema: string }) => r.schema));
    // Only meaningful when the result is complete.
    const missing = requested && !truncated ? requested.filter((s) => !foundSchemas.has(s)) : [];

    return {
      schemasApplied: requested ?? "all",
      schemasSource: source,
      tableCount: tables.length,
      truncated,
      ...(truncated && {
        note:
          `Only the first ${MAX_TABLES} tables are shown. Call list_schemas to see table counts, ` +
          `then call list_tables with fewer schemas, for example {"schemas": ["public"]}.`,
      }),
      ...(missing.length > 0 && {
        schemasWithNoTables: missing,
        hint: "These schemas returned no tables. Check the spelling with list_schemas, or the login may lack access.",
      }),
      tables,
    };
  } catch (error) {
    console.error("Error in list_tables:", error);
    throw error;
  } finally {
    client.release();
  }
}

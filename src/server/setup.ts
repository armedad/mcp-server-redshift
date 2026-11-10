import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { handleListTables, normalizeSchemasArg, ToolInputError } from "../tools/listTables.js";
import { handleGetTablesSchema } from "../tools/getTablesSchema.js";
import { handleQuery, resolveMaxRows, QueryInputError, DEFAULT_MAX_ROWS, MAX_ROWS_CEILING } from "../tools/query.js";
import { handleListSchemas } from "../tools/listSchemas.js";
import { config } from "../config/database.js";
import { formatResult } from "./format.js";
import { certName } from "../config/pool.js";

// Reported by server_info and the MCP handshake; kept in step with package.json.
const require = createRequire(import.meta.url);
export const SERVER_VERSION: string = require("../../package.json").version;

// Sent to the client when it connects; the model reads this alongside the tools.
// Deployments can append site-specific guidance (naming conventions, sensitive
// schemas, preferred views) through REDSHIFT_EXTRA_INSTRUCTIONS.
const BASE_INSTRUCTIONS = `Read-only access to an Amazon Redshift database.

How to explore:
1. Call list_schemas to see every schema and how many tables it has.
2. Call list_tables with the schemas you need, as an ARRAY of names: {"schemas": ["public"]} or {"schemas": ["sales", "marketing"]}. Never pass a single string. With no schemas it returns all schemas, capped at 500 rows, which is rarely what you want.
3. Check the "schemasApplied" field in every list_tables result to confirm the filter was used.
4. Call get_tables_schema for column details before writing SQL.
5. Call query with schema-qualified names, for example SELECT ... FROM sales.orders. Every query runs in a read-only transaction; writes fail.

Row cap:
- query returns at most ${DEFAULT_MAX_ROWS} rows by default. If a result says "truncated": true, prefer aggregating or filtering in SQL.
- Set max_rows above ${DEFAULT_MAX_ROWS} ONLY when the user explicitly asks for more rows (for example "give me all 5,000 rows"). Never raise it on your own. The hard maximum is ${MAX_ROWS_CEILING}.

Result format:
- Results are compact: an optional first line of JSON metadata (rowCount, truncated, schemasApplied and so on), then a "columns:" line, then one JSON array per row in that column order. When showing results to the user, render them as a readable table.

Conventions:
- Always add a LIMIT when sampling rows.
- External (Spectrum) schemas, shown as type "external" in list_schemas, can be slow to query.
- Prefer aggregates over row-level personal data, and query only what the user's task needs.`;

const EXTRA_INSTRUCTIONS = (process.env.REDSHIFT_EXTRA_INSTRUCTIONS ?? "").trim();
const INSTRUCTIONS =
  EXTRA_INSTRUCTIONS && !EXTRA_INSTRUCTIONS.startsWith("${")
    ? `${BASE_INSTRUCTIONS}\n\nSite-specific guidance:\n${EXTRA_INSTRUCTIONS}`
    : BASE_INSTRUCTIONS;

export function createServer() {
  const server = new Server(
    {
      name: "mcp-server-redshift",
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: INSTRUCTIONS,
    }
  );

  // Tool: List all tables, views, and materialized views
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [{
        name: "list_tables",
        description:
          'List tables, views and external tables in the given schemas. Pass schema names as an array: {"schemas": ["public"]}. ' +
          "Call list_schemas first to find schema names. Results are capped at 500 rows, and every result reports the schemas it applied in \"schemasApplied\".",
        inputSchema: {
          type: "object",
          properties: {
            schemas: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description:
                'Array of schema names, for example ["public"] or ["sales", "marketing"]. Do not pass a single string. ' +
                "Omit only to list every schema (capped at 500 rows).",
              examples: [["public"], ["sales", "marketing"]]
            }
          },
          additionalProperties: false
        }
      }, {
        name: "server_info",
        description: "Show this server's version, the host it connects to, and the name its TLS certificate is verified against. Contains no credentials.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }, {
        name: "list_schemas",
        description: "List every schema in the database with its type (local or external) and table count",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }, {
        name: "get_tables_schema",
        description: 'Get column names and types for one or more tables, for example {"tables": [{"schema": "sales", "table": "orders"}]}. Use before writing SQL.',
        inputSchema: {
          type: "object",
          properties: {
            tables: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  schema: {
                    type: "string",
                    description: "The schema name"
                  },
                  table: {
                    type: "string",
                    description: "The table name"
                  }
                },
                required: ["schema", "table"]
              },
              description: "List of tables to get schema information for"
            }
          },
          required: ["tables"]
        }
      }, {
        name: "query",
        description:
          `Run one read-only SQL query against Redshift. Use schema-qualified names (sales.orders) and add a LIMIT when sampling rows. Writes are rejected. ` +
          `Returns at most ${DEFAULT_MAX_ROWS} rows unless max_rows is set; only raise max_rows when the user explicitly asks for more rows.`,
        inputSchema: {
          type: "object",
          properties: {
            sql: {
              type: "string",
              description: "The SQL query to execute"
            },
            max_rows: {
              type: "integer",
              minimum: 1,
              maximum: MAX_ROWS_CEILING,
              description:
                `Optional row cap for this query. Default ${DEFAULT_MAX_ROWS}, maximum ${MAX_ROWS_CEILING}. ` +
                "Set it above the default ONLY when the user explicitly asks for more rows; never raise it on your own."
            },
          },
          required: ["sql"],
          additionalProperties: false,
        },
      }],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    try {
      switch (request.params.name) {
        case "list_tables": {
          let schemas: string[] | undefined;
          try {
            schemas = normalizeSchemasArg(request.params.arguments as Record<string, unknown> | undefined);
          } catch (e) {
            if (e instanceof ToolInputError) {
              return { content: [{ type: "text", text: e.message }], isError: true };
            }
            throw e;
          }
          const result = await handleListTables(schemas);
          return {
            content: [{
              type: "text",
              text: formatResult(result)
            }],
            isError: false,
          };
        }

        case "server_info": {
          const info = {
            version: SERVER_VERSION,
            host: config.host,
            port: config.port,
            database: config.database,
            tlsCertificateVerifiedAgainst: certName,
            schemas: config.schemas ?? "all",
            queryDefaultMaxRows: DEFAULT_MAX_ROWS,
            queryMaxRowsCeiling: MAX_ROWS_CEILING,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
            isError: false,
          };
        }

        case "list_schemas": {
          const result = await handleListSchemas();
          return {
            content: [{
              type: "text",
              text: formatResult(result)
            }],
            isError: false,
          };
        }

        case "get_tables_schema": {
          const { tables } = request.params.arguments as { tables: Array<{ schema: string; table: string }> };
          const result = await handleGetTablesSchema(tables);
          return {
            content: [{
              type: "text",
              text: formatResult(result)
            }],
            isError: false,
          };
        }

        case "query": {
          const sql = request.params.arguments?.sql as string;
          let maxRows: number;
          try {
            maxRows = resolveMaxRows(request.params.arguments?.max_rows);
          } catch (e) {
            if (e instanceof QueryInputError) {
              return { content: [{ type: "text", text: e.message }], isError: true };
            }
            throw e;
          }
          const result = await handleQuery(sql, maxRows);
          return {
            content: [{
              type: "text",
              text: formatResult(result)
            }],
            isError: false,
          };
        }

        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }
    } catch (error) {
      throw error;
    }
  });

  return server;
} 
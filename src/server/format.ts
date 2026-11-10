// Compact, token-efficient rendering of tool results.
//
// Rows are sent as a header line of column names followed by one JSON array
// per row, instead of pretty-printed objects that repeat every column name on
// every row. Metadata (row counts, truncation notes) goes on the first line.

type Row = Record<string, unknown>;

function isRowArray(v: unknown): v is Row[] {
  return Array.isArray(v) && v.every((r) => r !== null && typeof r === "object" && !Array.isArray(r));
}

function renderTable(rows: Row[]): string {
  if (rows.length === 0) return "columns: []\n(no rows)";
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  const lines = rows.map((row) => JSON.stringify(columns.map((c) => (row[c] === undefined ? null : row[c]))));
  return `columns: ${JSON.stringify(columns)}\n${lines.join("\n")}`;
}

export function formatResult(result: unknown): string {
  if (isRowArray(result)) return renderTable(result);

  if (result && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    const tableKey = ["rows", "tables"].find((k) => isRowArray(obj[k]));
    if (tableKey) {
      const { [tableKey]: table, ...meta } = obj;
      return `${JSON.stringify(meta)}\n${renderTable(table as Row[])}`;
    }
  }
  return JSON.stringify(result);
}

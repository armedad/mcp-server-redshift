import { pool } from "../config/pool.js";

export async function handleListSchemas() {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT
        s.schema_name AS schema,
        s.schema_type AS type,
        COUNT(t.table_name)::int AS tables
      FROM svv_all_schemas s
      LEFT JOIN svv_all_tables t
        ON t.database_name = s.database_name AND t.schema_name = s.schema_name
      WHERE s.database_name = current_database()
        AND s.schema_name NOT LIKE 'pg_%'
        AND s.schema_name NOT IN ('information_schema', 'catalog_history')
      GROUP BY s.schema_name, s.schema_type
      ORDER BY s.schema_name
    `);
    return result.rows;
  } catch (error) {
    console.error("Error in list_schemas:", error);
    throw error;
  } finally {
    client.release();
  }
}

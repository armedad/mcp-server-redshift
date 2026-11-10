export interface TableInfo {
  schema: string;
  name: string;
  description?: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  description?: string;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schemas: string[] | null; // null means all schemas
} 
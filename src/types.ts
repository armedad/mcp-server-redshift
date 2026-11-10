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

export type AuthMode = "password" | "iam";

export interface IamConfig {
  clusterId?: string; // derived from the endpoint name when not set
  region?: string; // derived from the endpoint name when not set
  accessKeyId?: string; // when unset, the default AWS credential chain is used
  secretAccessKey?: string;
  sessionToken?: string;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user?: string; // password auth: the login; IAM auth: optional database user to request
  password?: string;
  schemas: string[] | null; // null means all schemas
  auth: AuthMode;
  iam: IamConfig;
} 
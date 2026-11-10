import dotenv from "dotenv";
import { DatabaseConfig, AuthMode } from "../types.js";

// Load environment variables
dotenv.config();

// Read a setting. Blank values and unfilled "${...}" placeholders (left by some
// MCP hosts for optional fields) count as unset. When NAME is unset,
// NAME_DEFAULT is used, so a packaged deployment can ship defaults that a user
// can still override with their own value.
export function setting(name: string): string | undefined {
  for (const key of [name, `${name}_DEFAULT`]) {
    const value = process.env[key]?.trim();
    if (value && !value.startsWith("${")) return value;
  }
  return undefined;
}

// Turn a comma-separated schema setting into a list. Returns null, meaning
// "all schemas", when the value is blank, "*", "all", or an unfilled
// "${user_config...}" placeholder left behind by the extension host.
export function parseSchemas(raw: string | undefined): string[] | null {
  const value = (raw ?? "").trim();
  if (value === "" || value === "*" || value.toLowerCase() === "all" || value.startsWith("${")) {
    return null;
  }
  const list = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (list.some((s) => s === "*" || s.toLowerCase() === "all")) return null;
  return list.length > 0 ? list : null;
}

// password: connect with REDSHIFT_USER / REDSHIFT_PASSWORD.
// iam: exchange AWS credentials for temporary database credentials.
// When REDSHIFT_AUTH is not set, a configured password means "password",
// otherwise "iam".
function resolveAuthMode(): AuthMode {
  const explicit = setting("REDSHIFT_AUTH")?.toLowerCase();
  if (explicit === "password" || explicit === "iam") return explicit;
  if (explicit) throw new Error(`REDSHIFT_AUTH must be "password" or "iam", not "${explicit}".`);
  return setting("REDSHIFT_PASSWORD") ? "password" : "iam";
}

// Validate and load configuration
export const config: DatabaseConfig = {
  host: setting("REDSHIFT_HOST")!,
  port: parseInt(setting("REDSHIFT_PORT") || "5439", 10),
  database: setting("REDSHIFT_DATABASE")!,
  user: setting("REDSHIFT_USER"),
  password: setting("REDSHIFT_PASSWORD"),
  schemas: parseSchemas(setting("REDSHIFT_SCHEMAS")),
  auth: resolveAuthMode(),
  iam: {
    clusterId: setting("REDSHIFT_CLUSTER_ID"),
    region: setting("REDSHIFT_AWS_REGION") || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
    accessKeyId: setting("REDSHIFT_AWS_ACCESS_KEY_ID"),
    secretAccessKey: setting("REDSHIFT_AWS_SECRET_ACCESS_KEY"),
    sessionToken: setting("REDSHIFT_AWS_SESSION_TOKEN"),
  },
};

// Validate required settings
export function validateConfig() {
  const missing = ["REDSHIFT_HOST", "REDSHIFT_DATABASE"].filter((name) => !setting(name));
  if (config.auth === "password") {
    for (const name of ["REDSHIFT_USER", "REDSHIFT_PASSWORD"]) if (!setting(name)) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`Missing required setting(s): ${missing.join(", ")}`);
  }
  const { accessKeyId, secretAccessKey } = config.iam;
  if (config.auth === "iam" && Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error(
      "Set both REDSHIFT_AWS_ACCESS_KEY_ID and REDSHIFT_AWS_SECRET_ACCESS_KEY, or neither to use the default AWS credential chain."
    );
  }
}

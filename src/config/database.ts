import dotenv from "dotenv";
import { DatabaseConfig } from "../types.js";

// Load environment variables
dotenv.config();

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

// Validate and load configuration
export const config: DatabaseConfig = {
  host: process.env.REDSHIFT_HOST!,
  port: parseInt(process.env.REDSHIFT_PORT || "5439"),
  database: process.env.REDSHIFT_DATABASE!,
  user: process.env.REDSHIFT_USER!,
  password: process.env.REDSHIFT_PASSWORD!,
  schemas: parseSchemas(process.env.REDSHIFT_SCHEMAS),
};

// Validate required environment variables
export function validateConfig() {
  const requiredEnvVars = ["REDSHIFT_HOST", "REDSHIFT_DATABASE", "REDSHIFT_USER", "REDSHIFT_PASSWORD"];
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }
} 
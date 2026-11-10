import pg from "pg";
import dns from "node:dns/promises";
import tls from "node:tls";
import {
  RedshiftClient,
  GetClusterCredentialsCommand,
  GetClusterCredentialsWithIAMCommand,
} from "@aws-sdk/client-redshift";
import { config, setting } from "./database.js";

// Redshift certificates are issued for the cluster's real AWS endpoint name
// (for example *.xxxxxxxx.region.redshift.amazonaws.com). Users often connect
// through a friendlier CNAME alias, which would fail hostname verification.
// Follow the alias to its real AWS endpoint and verify the certificate against
// that name instead. Certificate chain checking stays on.
const AWS_REDSHIFT_SUFFIXES = [".redshift.amazonaws.com", ".redshift-serverless.amazonaws.com"];

async function resolveCertName(host: string): Promise<string> {
  const isAwsEndpoint = (n: string) => AWS_REDSHIFT_SUFFIXES.some((s) => n.toLowerCase().endsWith(s));
  let name = host;
  for (let hop = 0; hop < 5; hop++) {
    if (isAwsEndpoint(name)) return name; // stop at the first real Redshift name
    try {
      const targets = await dns.resolveCname(name);
      if (targets.length === 0) break;
      name = targets[0].replace(/\.$/, "");
    } catch {
      break; // no CNAME here: the chain ended without reaching a Redshift name
    }
  }
  return isAwsEndpoint(name) ? name : host;
}

// An explicit override wins, for anyone who wants to pin the expected name.
export const certName = setting("REDSHIFT_CERT_HOST") || (await resolveCertName(config.host));
console.error(`TLS: connecting to ${config.host}, verifying certificate for ${certName}`);

// --- IAM authentication -----------------------------------------------------

// A provisioned endpoint looks like <cluster-id>.<unique>.<region>.redshift.amazonaws.com.
const PROVISIONED_ENDPOINT = /^([^.]+)\.[^.]+\.([a-z0-9-]+)\.redshift\.amazonaws\.com$/i;

export function iamTarget(): { clusterId?: string; region?: string } {
  const match = certName.match(PROVISIONED_ENDPOINT);
  return {
    clusterId: config.iam.clusterId || match?.[1],
    region: config.iam.region || match?.[2],
  };
}

interface DbCredentials {
  user: string;
  password: string;
  expiresAt: number | null; // epoch ms; null means it does not expire
}

// Exchange AWS credentials for temporary database credentials. With
// REDSHIFT_USER set, GetClusterCredentials requests that database user;
// otherwise GetClusterCredentialsWithIAM maps the IAM identity to a user.
async function fetchIamCredentials(): Promise<DbCredentials> {
  if (certName.toLowerCase().endsWith(".redshift-serverless.amazonaws.com")) {
    throw new Error("IAM authentication currently supports provisioned clusters only, not Redshift Serverless.");
  }
  const { clusterId, region } = iamTarget();
  if (!clusterId || !region) {
    throw new Error(
      "IAM authentication needs the cluster identifier and region. They could not be derived from the host; set REDSHIFT_CLUSTER_ID and REDSHIFT_AWS_REGION."
    );
  }
  const { accessKeyId, secretAccessKey, sessionToken } = config.iam;
  const client = new RedshiftClient({
    region,
    // Without an explicit key the SDK's default credential chain is used
    // (AWS_PROFILE, environment variables, SSO, instance roles, and so on).
    ...(accessKeyId && secretAccessKey && { credentials: { accessKeyId, secretAccessKey, sessionToken } }),
  });
  const durationSeconds = 3600;
  const response = config.user
    ? await client.send(
        new GetClusterCredentialsCommand({
          ClusterIdentifier: clusterId,
          DbUser: config.user,
          DbName: config.database,
          DurationSeconds: durationSeconds,
          AutoCreate: false,
        })
      )
    : await client.send(
        new GetClusterCredentialsWithIAMCommand({
          ClusterIdentifier: clusterId,
          DbName: config.database,
          DurationSeconds: durationSeconds,
        })
      );
  if (!response.DbUser || !response.DbPassword) {
    throw new Error("AWS did not return database credentials.");
  }
  return {
    user: response.DbUser,
    password: response.DbPassword,
    expiresAt: response.Expiration ? new Date(response.Expiration).getTime() : Date.now() + durationSeconds * 1000,
  };
}

// --- Connection pool ----------------------------------------------------------

const REFRESH_MARGIN_MS = 2 * 60 * 1000; // renew IAM credentials two minutes early

let current: { pool: pg.Pool; credentials: DbCredentials } | null = null;
let pending: Promise<pg.Pool> | null = null;

function createPool(credentials: DbCredentials): pg.Pool {
  return new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: credentials.user,
    password: credentials.password,
    ssl: {
      // Certificate chain verification stays on. node-postgres overwrites
      // `servername` with the connection host, so the hostname check is done
      // here instead, against the real Redshift endpoint name.
      rejectUnauthorized: true,
      checkServerIdentity: (_hostname: string, cert: tls.PeerCertificate) =>
        tls.checkServerIdentity(certName, cert),
    },
  });
}

function isFresh(credentials: DbCredentials): boolean {
  return credentials.expiresAt === null || Date.now() < credentials.expiresAt - REFRESH_MARGIN_MS;
}

async function getPool(): Promise<pg.Pool> {
  if (current && isFresh(current.credentials)) return current.pool;
  if (!pending) {
    pending = (async () => {
      const credentials: DbCredentials =
        config.auth === "iam"
          ? await fetchIamCredentials()
          : { user: config.user!, password: config.password!, expiresAt: null };
      const previous = current;
      current = { pool: createPool(credentials), credentials };
      // Let checked-out clients finish, then close the old pool.
      previous?.pool.end().catch(() => {});
      return current.pool;
    })().finally(() => {
      pending = null;
    });
  }
  return pending;
}

// Same shape the tools already use: pool.connect() returns a client.
export const pool = {
  connect: async () => (await getPool()).connect(),
};

// Non-secret details for server_info.
export function authInfo() {
  const info: Record<string, unknown> = { authMode: config.auth };
  if (config.auth === "iam") {
    const { clusterId, region } = iamTarget();
    info.clusterId = clusterId ?? null;
    info.region = region ?? null;
    info.awsCredentialSource = config.iam.accessKeyId ? "access key" : "default AWS credential chain";
    info.requestedDbUser = config.user ?? "(mapped from IAM identity)";
    if (current) {
      info.connectedAs = current.credentials.user;
      info.credentialsExpireAt = current.credentials.expiresAt
        ? new Date(current.credentials.expiresAt).toISOString()
        : null;
    }
  } else {
    info.user = config.user;
  }
  return info;
}

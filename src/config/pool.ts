import pg from "pg";
import dns from "node:dns/promises";
import tls from "node:tls";
import { config } from "./database.js";

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
export const certName = process.env.REDSHIFT_CERT_HOST?.trim() || (await resolveCertName(config.host));
console.error(`TLS: connecting to ${config.host}, verifying certificate for ${certName}`);

// Create database pool
export const pool = new pg.Pool({
  host: config.host,
  port: config.port,
  database: config.database,
  user: config.user,
  password: config.password,
  ssl: {
    // Certificate chain verification stays on. node-postgres overwrites
    // `servername` with the connection host, so the hostname check is done
    // here instead, against the real Redshift endpoint name.
    rejectUnauthorized: true,
    checkServerIdentity: (_hostname: string, cert: tls.PeerCertificate) =>
      tls.checkServerIdentity(certName, cert),
  },
});

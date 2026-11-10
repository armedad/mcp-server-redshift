# MCP Server for Redshift

A Model Context Protocol (MCP) server implementation for Amazon Redshift, providing a standardized interface for interacting with Redshift databases through AI models.

## Features

- List every schema with its type (local or external) and table count
- List tables, views, and external (Spectrum) tables across one, several, or all schemas
- Get detailed schema information for multiple tables in a single request
- Execute read-only SQL queries against Redshift, with a row cap the caller can raise per query
- Compact, token-efficient result format
- Server instructions that teach the model how to use the tools, extendable per deployment
- TLS certificate verification that works when connecting through a DNS alias (CNAME)
- Support for both stdio and SSE (Server-Sent Events) transport
- Type-safe implementation in TypeScript

## Prerequisites

- Node.js 18 or higher
- Access to a Redshift database
- Environment variables configured (see Configuration section)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/mcp-server-redshift.git
   cd mcp-server-redshift
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

## Configuration

Create a `.env` file in the root directory with the following variables:

```env
# Redshift Connection
REDSHIFT_HOST=your-redshift-host
REDSHIFT_PORT=5439
REDSHIFT_DATABASE=your-database

# Authentication: set a user and password, or use IAM (see Authentication below)
REDSHIFT_USER=your-username
REDSHIFT_PASSWORD=your-password

# Optional
REDSHIFT_SCHEMAS=public,schema1  # Default schemas for list_tables; blank, "all" or "*" means every schema
REDSHIFT_CERT_HOST=              # Hostname to verify the TLS certificate against (see TLS below)
REDSHIFT_EXTRA_INSTRUCTIONS=     # Site-specific guidance appended to the server instructions

# Server Configuration
TRANSPORT_TYPE=stdio  # or 'sse' for Server-Sent Events
PORT=3000  # Only used when TRANSPORT_TYPE=sse
```

### Authentication

Two modes are supported. `REDSHIFT_AUTH` forces one; when it is not set, a
configured `REDSHIFT_PASSWORD` means password auth, otherwise IAM.

**Password:** `REDSHIFT_USER` and `REDSHIFT_PASSWORD`.

**IAM:** the server exchanges AWS credentials for temporary database
credentials (valid for one hour, renewed automatically before they expire).

| Setting | Purpose |
|---|---|
| `REDSHIFT_AWS_ACCESS_KEY_ID`, `REDSHIFT_AWS_SECRET_ACCESS_KEY`, `REDSHIFT_AWS_SESSION_TOKEN` | AWS credentials. When unset, the default AWS credential chain is used (`AWS_PROFILE`, environment variables, SSO, instance roles) |
| `REDSHIFT_USER` | Optional. When set, requests that database user with `GetClusterCredentials` (needs `redshift:GetClusterCredentials` on that user). When unset, `GetClusterCredentialsWithIAM` maps the IAM identity to a database user (needs `redshift:GetClusterCredentialsWithIAM`) |
| `REDSHIFT_CLUSTER_ID`, `REDSHIFT_AWS_REGION` | Optional. Derived from the cluster endpoint name, including when connecting through a DNS alias |

IAM authentication currently supports provisioned clusters, not Redshift Serverless.

### Packaged defaults

Every setting also accepts a `NAME_DEFAULT` variant (for example
`REDSHIFT_AWS_ACCESS_KEY_ID_DEFAULT`) that is used when `NAME` is blank. This lets
a deployment ship defaults, such as a shared read-only IAM key, while users can
still supply their own values. Anything shipped this way is readable by everyone
who receives the package, so use a least-privilege identity and rotate it.

### TLS

Connections use TLS with full certificate verification. Redshift certificates are
issued for the cluster's AWS endpoint name (`*.xxxxxxxx.region.redshift.amazonaws.com`),
so connecting through a friendlier DNS alias normally fails hostname verification.
The server follows the alias's CNAME chain to the first `*.redshift.amazonaws.com`
(or `*.redshift-serverless.amazonaws.com`) name and verifies the certificate against
it. Set `REDSHIFT_CERT_HOST` to pin the expected name explicitly; this is recommended
if you do not control the alias's DNS.

### Server instructions

On connect the server sends usage instructions to the client (schemas first, then
tables, then columns, then queries; how to pass the `schemas` array; the row cap;
the result format). Add deployment-specific guidance, such as naming conventions,
preferred views, or sensitive schemas to avoid, with `REDSHIFT_EXTRA_INSTRUCTIONS`.
Write `\n` in the value for a line break, so it can be set on a single line.

## Usage

### Running the Server

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

### Available Tools

1. **List Schemas** (`list_schemas`)
   - Lists every schema with its type (`local` or `external`) and table count
   - A good first call before `list_tables`

2. **List Tables** (`list_tables`)
   - Lists tables, views, and external tables in the given schemas
   - `schemas` is an array of schema names. Common variations (`schema`, a single
     string, a comma-separated string) are accepted; unknown arguments return an
     error that shows the correct format instead of silently listing everything
   - With no schemas it uses `REDSHIFT_SCHEMAS`, or every schema if that is blank
   - Results are capped at 500 rows and report `schemasApplied`
   ```json
   {
     "schemas": ["public", "analytics"]
   }
   ```

3. **Get Tables Schema** (`get_tables_schema`)
   - Get schema information for multiple tables across different schemas
   ```json
   {
     "tables": [
       { "schema": "public", "table": "users" },
       { "schema": "analytics", "table": "events" }
     ]
   }
   ```

4. **Query** (`query`)
   - Execute read-only SQL queries against the database
   - Returns at most 1,000 rows by default. Set `max_rows` (up to 10,000) to raise
     the cap for one query; the instructions tell the model to do this only when
     the user explicitly asks. Single statements are streamed through a cursor, so
     Redshift stops sending rows at the cap
   ```json
   {
     "sql": "SELECT * FROM public.users",
     "max_rows": 5000
   }
   ```

5. **Server Info** (`server_info`)
   - Shows the server version, host, database, the name the TLS certificate is
     verified against, and the row-cap limits. Contains no credentials

### Result format

Results are compact to save tokens: an optional first line of JSON metadata, a
`columns:` line, then one JSON array per row.

```
{"rowCount":2,"maxRowsApplied":1000,"truncated":false}
columns: ["id","name"]
[1,"alice"]
[2,"bob"]
```

### Testing

Run the test suite:
   ```bash
   npm test
   ```

## Architecture

The project is organized into the following structure:

```
src/
├── config/         # Configuration and database setup
├── tools/          # Individual tool implementations
├── server/         # Server setup and transport configuration
└── index.ts        # Main entry point
```

## Security Considerations

- All queries are executed in read-only transactions that are always rolled back
- `query` accepts exactly one statement per call and refuses transaction-control statements (BEGIN, COMMIT, SET TRANSACTION and similar), so a query cannot end the read-only transaction and run further statements outside it. Statements are sent with the extended query protocol, which also makes the server reject multiple commands
- Use a dedicated, least-privilege database user; its grants are the real security boundary
- IAM authentication uses short-lived database credentials; secrets are never logged or returned by `server_info`
- TLS certificates are always verified (see TLS above)
- Logs go to stderr, so they never corrupt the stdio MCP stream
- Environment variables should be properly secured
- CORS is enabled for SSE transport (should be configured for production)
- Database credentials should be managed securely

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

This project is based on the [PostgreSQL MCP server](https://github.com/modelcontextprotocol/servers/tree/main/src/postgres) from the Model Context Protocol project. Special thanks to the original authors for their work. 
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "dotenv";
import { resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env
const envPath = resolve(__dirname, "../.env");
const result = config({ path: envPath });

if (result.error) {
  console.error("Error loading .env file:", result.error);
  process.exit(1);
}

// Verify required environment variables
const requiredEnvVars = ["REDSHIFT_HOST", "REDSHIFT_DATABASE", "REDSHIFT_USER", "REDSHIFT_PASSWORD"];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error("Missing required environment variables:", missingVars.join(", "));
  console.error("Please make sure your .env file contains all required variables.");
  process.exit(1);
}

// Create a clean environment object with only string values
const cleanEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) {
    cleanEnv[key] = value;
  }
}

interface ToolResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError: boolean;
}

async function runTests() {
  try {
    // Create MCP client with transport (this will start the server)
    const transport = new StdioClientTransport({
      command: "node",
      args: [join(__dirname, "../dist/index.js")],
      env: cleanEnv
    });
    
    const client = new Client(
      {
        name: "mcp-test-client",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Connect to the server
    await client.connect(transport);
    console.log("Connected to MCP server\n");

    // Test 1: List available tools
    console.log("Test 1: Listing available tools");
    const tools = await client.listTools({});
    console.log("Available tools:", JSON.stringify(tools, null, 2));
    console.log();

    // Test 2: List tables (using default schemas)
    console.log("Test 2: Listing tables (default schemas)");
    const listTablesResult = await client.callTool({
      name: "list_tables",
      arguments: {}
    }) as ToolResponse;
    console.log("Tables:", listTablesResult.content[0].text);
    console.log();

    // Test 3: List tables (specific schema)
    console.log("Test 3: Listing tables (specific schema)");
    const listTablesSchemaResult = await client.callTool({
      name: "list_tables",
      arguments: {
        schemas: ["utility_go"]
      }
    }) as ToolResponse;
    console.log("Tables in utility_go schema:", listTablesSchemaResult.content[0].text);
    console.log();

    // Test 4: Get table schemas
    console.log("Test 4: Getting table schemas");
    const getSchemaResult = await client.callTool({
      name: "get_tables_schema",
      arguments: {
        tables: [
          { schema: "utility_go", table: "users" },
          { schema: "utility_go", table: "events" }
        ]
      }
    }) as ToolResponse;
    console.log("Table schemas:", getSchemaResult.content[0].text);
    console.log();

    // Test 5: Execute query
    console.log("Test 5: Executing query");
    const queryResult = await client.callTool({
      name: "query",
      arguments: {
        sql: "SELECT * FROM utility_go.users LIMIT 5"
      }
    }) as ToolResponse;
    console.log("Query result:", queryResult.content[0].text);
    console.log();

    console.log("All tests completed successfully!");
    
  } catch (error) {
    console.error("Error running tests:", error);
    process.exit(1);
  } finally {
    // Exit the process
    process.exit(0);
  }
}

// Run the tests
runTests(); 
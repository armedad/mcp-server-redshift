import express from "express";
import { Request, Response } from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

export async function setupTransport(server: Server) {
  const transportType = process.env.TRANSPORT_TYPE || "stdio";
  const port = parseInt(process.env.PORT || "3000");

  if (transportType === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MCP server started with stdio transport");
  } else if (transportType === "sse") {
    const app = express();

    // CORS middleware
    app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*"); // Replace with specific origin in prod
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      next();
    });

    // Handle preflight OPTIONS requests
    app.options("*", (_, res) => res.sendStatus(200));
    
    // Store active SSE transports
    const transports: {[sessionId: string]: SSEServerTransport} = {};

    // SSE endpoint
    app.get("/sse", async (_: Request, res: Response) => {
      console.error("New SSE connection established");
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;
      
      res.on("close", () => {
        console.error("SSE connection closed");
        delete transports[transport.sessionId];
      });
      
      await server.connect(transport);
      console.error("SSE transport connected successfully");
    });

    // Messages endpoint
    app.post("/messages", async (req: Request, res: Response) => {
      let matched = false;
    
      for (const transport of Object.values(transports)) {
        try {
          await transport.handlePostMessage(req, res);
          matched = true;
          break;
        } catch (err) {
          // Not this transport — keep trying others
        }
      }
    
      if (!matched) {
        res.status(400).send("No matching transport for session");
      }
    });

    app.listen(port, () => {
      console.error(`MCP server started with SSE transport on port ${port}`);
      console.error(`Server listening on http://localhost:${port}`);
    });
  } else {
    throw new Error(`Unsupported transport type: ${transportType}`);
  }
} 
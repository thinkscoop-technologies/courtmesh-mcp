#!/usr/bin/env node
/**
 * Entry point for the CourtMesh MCP server.
 *
 * Selects a transport at startup:
 *   - stdio (default): for Claude Desktop, Claude Code, Cursor and other local MCP clients.
 *   - Streamable HTTP: pass --http, or set MCP_TRANSPORT=http, to run as a long lived HTTP
 *     server suitable for hosting at a public URL such as mcp.courtmesh.ai/mcp.
 *
 * Neither transport requires a valid API key at startup. Tools list fine without one; only
 * an actual API call fails, with a readable 401 style message, if no key was supplied.
 */

import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerCourtMeshTools } from "./tools.js";
import { apiKeyOverrideStorage } from "./context.js";
import { DEFAULT_BASE_URL, isValidApiKeyFormat } from "./client.js";

const SERVER_NAME = "courtmesh-mcp";
const SERVER_VERSION = "0.1.0";

const baseUrl = process.env.COURTMESH_API_BASE_URL?.trim() || DEFAULT_BASE_URL;
const apiKey = process.env.COURTMESH_API_KEY?.trim() || undefined;

function warnIfKeyLooksWrong(key: string | undefined, sourceLabel: string): void {
  if (key && !isValidApiKeyFormat(key)) {
    // Deliberately written to stderr, never stdout, so it cannot corrupt the stdio JSON-RPC stream.
    console.error(
      `[courtmesh-mcp] Warning: the ${sourceLabel} does not match the expected CourtMesh API key format ` +
        "(cm- or vv- prefix, 32 base64url chars, dash, 4 base64url chars). Requests will still be sent with " +
        "this value, but the CourtMesh API will likely reject it with a 401."
    );
  }
}

function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerCourtMeshTools(server, { baseUrl, apiKey });
  return server;
}

async function runStdio(): Promise<void> {
  warnIfKeyLooksWrong(apiKey, "COURTMESH_API_KEY environment variable");
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[courtmesh-mcp] stdio transport ready, base URL ${baseUrl}.`);
}

async function runHttp(): Promise<void> {
  const port = Number(process.env.PORT) || 3000;
  const app = express();
  app.use(express.json());

  // Plain health check for the HTTP server process itself, distinct from the
  // check_api_health tool, which checks the upstream CourtMesh API instead.
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  function tokenFromRequest(req: Request): string | undefined {
    const token = req.query.token;
    if (typeof token === "string" && token.length > 0) {
      warnIfKeyLooksWrong(token, "?token= query parameter");
      return token;
    }
    return undefined;
  }

  async function handleMcpRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport) {
      if (req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, transport as StreamableHTTPServerTransport);
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };
        const server = createServer();
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session, and request was not an initialize request." },
          id: null,
        });
        return;
      }
    }

    const apiKeyOverride = tokenFromRequest(req);
    await apiKeyOverrideStorage.run(apiKeyOverride, () => transport!.handleRequest(req, res, req.body));
  }

  app.post("/mcp", (req, res) => {
    handleMcpRequest(req, res).catch((err) => {
      console.error("[courtmesh-mcp] Error handling POST /mcp:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    });
  });

  app.get("/mcp", (req, res) => {
    handleMcpRequest(req, res).catch((err) => {
      console.error("[courtmesh-mcp] Error handling GET /mcp:", err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
  });

  app.delete("/mcp", (req, res) => {
    handleMcpRequest(req, res).catch((err) => {
      console.error("[courtmesh-mcp] Error handling DELETE /mcp:", err);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
  });

  app.listen(port, () => {
    console.error(`[courtmesh-mcp] Streamable HTTP transport ready on port ${port}, mounted at /mcp, base URL ${baseUrl}.`);
  });
}

const args = process.argv.slice(2);
const useHttp = args.includes("--http") || process.env.MCP_TRANSPORT === "http";

if (useHttp) {
  runHttp().catch((err) => {
    console.error("[courtmesh-mcp] Fatal error starting HTTP transport:", err);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    console.error("[courtmesh-mcp] Fatal error starting stdio transport:", err);
    process.exit(1);
  });
}

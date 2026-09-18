#!/usr/bin/env node
/**
 * Entry point for the CourtMesh MCP server.
 *
 * Selects a transport at startup:
 *   - stdio (default): for Claude Desktop, Claude Code, Cursor and other local MCP clients.
 *   - Streamable HTTP: pass --http, or set MCP_TRANSPORT=http, to run as a long lived HTTP
 *     server suitable for hosting at a public URL such as mcp.courtmesh.ai/mcp.
 *
 * Neither transport requires a valid API key at startup. Over stdio, tools list fine without
 * one; only an actual API call fails, with a readable 401 style message, if no key was supplied.
 *
 * The HTTP transport is different, because it is reachable by anyone: it requires a well formed
 * key on EVERY request, checked before a session is allocated, and it caps, ages out and binds
 * the sessions it does allocate. See handleMcpRequest.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerCourtMeshTools } from "./tools.js";
import { apiKeyOverrideStorage } from "./context.js";
import { DEFAULT_BASE_URL, isValidApiKeyFormat } from "./client.js";

const SERVER_NAME = "courtmesh-mcp";
const SERVER_VERSION = "0.3.0";

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

// ---------------------------------------------------------------------------
// HTTP transport limits
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Hard ceiling on live sessions, and therefore on the memory this process can
 * be made to hold. One session is a StreamableHTTPServerTransport plus its own
 * McpServer with every tool registered, measured at roughly 220 KB of RSS, so
 * the default cap is worth about 45 MB on a box that has 2 GB for eight apps.
 * When the cap is reached the least recently used session is closed, which is
 * the correct trade: an idle session is worth less than a live one.
 */
const MAX_SESSIONS = envInt("MCP_MAX_SESSIONS", 200);

/**
 * Per key ceiling. One credential cannot take the whole map, so a single
 * misbehaving or hostile client degrades only itself. Legitimate clients hold
 * one session per connected editor, so this is far above real use.
 */
const MAX_SESSIONS_PER_KEY = envInt("MCP_MAX_SESSIONS_PER_KEY", 8);

/** A session with no request for this long is closed by the sweep below. */
const SESSION_IDLE_MS = envInt("MCP_SESSION_IDLE_MS", 30 * 60_000);

/** How often the idle sweep runs. */
const SESSION_SWEEP_MS = envInt("MCP_SESSION_SWEEP_MS", 60_000);

/** New sessions per minute per client address. Bounds the allocation rate. */
const INIT_PER_MIN = envInt("MCP_INIT_PER_MIN", 20);

/** How many client addresses the initialize limiter tracks at once. */
const INIT_MAX_TRACKED = envInt("MCP_INIT_MAX_TRACKED", 5_000);

/**
 * The client address, used only for the initialize rate limit.
 *
 * nginx sets X-Forwarded-For to $proxy_add_x_forwarded_for, which appends the
 * peer it actually saw to whatever the client sent, so the RIGHTMOST entry is
 * the only one the client could not choose. The leftmost entry, which is what
 * req.ip would give under `trust proxy`, is attacker controlled and would hand
 * out one fresh identity per request.
 */
function clientAddress(req: Request): string {
  const header = req.headers["x-forwarded-for"];
  const chain = Array.isArray(header) ? header.join(",") : String(header ?? "");
  const parts = chain.split(",").map((p) => p.trim()).filter(Boolean);
  const raw = parts.length > 0 ? parts[parts.length - 1] : String(req.socket?.remoteAddress ?? "");
  return raw.toLowerCase() || "unknown";
}

interface RateWindow {
  count: number;
  resetAt: number;
}

const initWindows = new Map<string, RateWindow>();

/** Fixed window limiter for session creation. Bounded, so it cannot itself leak. */
function allowInitialize(address: string): boolean {
  const now = Date.now();
  const existing = initWindows.get(address);
  if (existing && existing.resetAt > now) {
    if (existing.count >= INIT_PER_MIN) return false;
    existing.count += 1;
    return true;
  }
  initWindows.set(address, { count: 1, resetAt: now + 60_000 });
  if (initWindows.size > INIT_MAX_TRACKED) {
    for (const [key, window] of initWindows) {
      if (window.resetAt <= now) initWindows.delete(key);
      if (initWindows.size <= INIT_MAX_TRACKED) break;
    }
    while (initWindows.size > INIT_MAX_TRACKED) {
      const oldest = initWindows.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === address) break;
      initWindows.delete(oldest);
    }
  }
  return true;
}

/** sha256 of the presented key. The key itself is never stored. */
function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Constant time comparison of two hex digests of equal length. */
function sameKeyHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** Binds the session to the credential that created it. See attachment check. */
  keyHash: string;
  lastSeenMs: number;
}

async function runHttp(): Promise<void> {
  const port = Number(process.env.PORT) || 3000;
  const app = express();
  // Never advertise the framework.
  app.disable("x-powered-by");
  // The limit is Express's own default, stated explicitly so it is a decision
  // rather than an accident: a JSON-RPC tool call is a few kilobytes.
  app.use(express.json({ limit: "100kb" }));

  // Plain health check for the HTTP server process itself, distinct from the
  // check_api_health tool, which checks the upstream CourtMesh API instead.
  // Deliberately unauthenticated and allocation free, so uptime monitoring
  // works without a credential.
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  /**
   * Live sessions, most recently used LAST.
   *
   * A Map iterates in insertion order, so re-inserting an entry on every request
   * makes the first key the least recently used one, which is what the eviction
   * below takes. Entries leave this map by exactly four routes: the client sends
   * DELETE /mcp, the transport closes for any other reason, the idle sweep
   * reaps them, or the cap evicts them. Before this existed the ONLY route was
   * the explicit DELETE, so an anonymous caller could allocate without bound.
   */
  const sessions = new Map<string, McpSession>();

  function touch(sessionId: string, session: McpSession): void {
    session.lastSeenMs = Date.now();
    sessions.delete(sessionId);
    sessions.set(sessionId, session);
  }

  /** Drop a session and release its transport and server. */
  function closeSession(sessionId: string, reason: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    // McpServer.close() closes the transport it is connected to, which is what
    // frees the SSE response and the per session tool registrations.
    void Promise.resolve()
      .then(() => session.server.close())
      .catch((err) => console.error(`[courtmesh-mcp] Error closing session (${reason}):`, err?.message ?? err));
  }

  /** Close every session older than the idle TTL. */
  function sweepIdleSessions(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [sessionId, session] of sessions) {
      // Insertion order is recency order, so the first entry that is fresh
      // enough means every entry after it is too.
      if (session.lastSeenMs > cutoff) break;
      closeSession(sessionId, "idle");
    }
  }

  /** Enforce the global and per key ceilings before a new session is allocated. */
  function makeRoomFor(keyHash: string): void {
    const mine: string[] = [];
    for (const [sessionId, session] of sessions) {
      if (sameKeyHash(session.keyHash, keyHash)) mine.push(sessionId);
    }
    // Oldest first, closing enough of this key's own sessions to leave room for
    // the one about to be created.
    for (let i = 0; mine.length - i >= MAX_SESSIONS_PER_KEY; i += 1) {
      closeSession(mine[i], "per-key cap");
    }
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      closeSession(oldest, "global cap");
    }
  }

  const sweepTimer = setInterval(sweepIdleSessions, SESSION_SWEEP_MS);
  // Do not hold the process open for the sweep alone.
  sweepTimer.unref?.();

  /**
   * Read the caller's CourtMesh API key from an HTTP request.
   *
   * Two accepted forms, in this order:
   *   1. Authorization: Bearer <key>
   *   2. ?token=<key>
   *
   * The header is preferred because a key in a query string ends up in access
   * logs, proxy logs and browser history, and because it matches how the REST
   * API itself authenticates (see authenticateApiKey, which takes either
   * X-API-Key or Authorization: Bearer). The query parameter stays supported
   * because several MCP clients can only configure a URL, with no way to attach
   * a header.
   *
   * This previously read the query parameter ONLY, while the published setup
   * page documented the bearer header. Every documented client config would
   * therefore have connected anonymously and 401'd on the first tool call.
   *
   * NOTHING IS LOGGED HERE, and that is deliberate. This used to call
   * warnIfKeyLooksWrong on whatever the caller sent, which was harmless while
   * the warning only ever fired for a local operator's own misconfigured stdio
   * key. On a public HTTP endpoint it is a log line per request, chosen by a
   * stranger, so a flood of malformed keys becomes a flood of disk writes on a
   * box that has run out of disk before. The caller is told what is wrong in
   * the 401 body instead, which is where it belongs.
   */
  function tokenFromRequest(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) {
      const token = auth.replace(/^Bearer\s+/i, "").trim();
      if (token.length > 0) return token;
    }
    const token = req.query.token;
    if (typeof token === "string" && token.length > 0) return token;
    return undefined;
  }

  /** JSON-RPC shaped refusal. Never carries a stack, a path or a dependency name. */
  function refuse(res: Response, status: number, code: number, message: string): void {
    if (res.headersSent) return;
    res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
  }

  async function handleMcpRequest(req: Request, res: Response): Promise<void> {
    /*
     * AUTHENTICATION BEFORE ALLOCATION.
     *
     * Everything below this block is cheap; everything above the transport
     * construction has to stay that way. A session costs roughly 220 KB of RSS
     * and used to be created for any anonymous POST that looked like an
     * initialize, with the entry removed only when the client sent an explicit
     * DELETE. A few thousand unauthenticated POSTs were therefore enough to
     * exhaust a 2 GB box that also runs seven other apps.
     *
     * The format check is not a validity check: only the CourtMesh API can say
     * whether a key is real, and asking it here would put a network call in
     * front of every request. It does mean an unauthenticated caller is refused
     * with a 401 before anything is allocated, and a caller who does present a
     * well formed key is bounded by the per key and global ceilings below.
     */
    const presentedKey = tokenFromRequest(req);
    if (!presentedKey || !isValidApiKeyFormat(presentedKey)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="courtmesh-mcp"');
      refuse(
        res,
        401,
        -32001,
        "Unauthorized: a CourtMesh API key is required. Send it as 'Authorization: Bearer <key>', " +
          "or as ?token=<key> if your client cannot set headers. Get a key at https://research.courtmesh.ai.",
      );
      return;
    }
    const keyHash = hashKey(presentedKey);

    /*
     * SESSION BINDING. A session id is a bearer token for everything that
     * session can do: its SSE stream, its tool calls and its termination. It
     * used to be the ONLY thing needed, so anyone who learned an id could
     * attach to that stream or DELETE the session. Binding the session to a
     * hash of the credential that created it makes the id alone useless.
     *
     * A session that is not the caller's own is treated as one that does not
     * exist, and an id that no longer exists (evicted at the cap, reaped by the
     * idle sweep, or simply never issued) gets the identical answer, so this
     * cannot be used to probe which ids are live. 404 with -32001 is also what
     * the SDK itself returns for a mismatched id, which is what a well behaved
     * client re-initializes on.
     */
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const found = sessionId ? sessions.get(sessionId) : undefined;
    const owned = found && sameKeyHash(found.keyHash, keyHash) ? found : undefined;
    let transport: StreamableHTTPServerTransport;

    if (owned) {
      touch(sessionId as string, owned);
      transport = owned.transport;
    } else if (req.method === "POST" && isInitializeRequest(req.body)) {
      if (!allowInitialize(clientAddress(req))) {
        res.setHeader("Retry-After", "60");
        refuse(res, 429, -32002, "Too many new sessions from this address. Retry in a minute.");
        return;
      }
      makeRoomFor(keyHash);

      const server = createServer();
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, {
            transport: created,
            server,
            keyHash,
            lastSeenMs: Date.now(),
          });
        },
      });
      created.onclose = () => {
        if (created.sessionId) sessions.delete(created.sessionId);
      };
      await server.connect(created);
      transport = created;
    } else if (sessionId) {
      refuse(res, 404, -32001, "Session not found.");
      return;
    } else {
      refuse(
        res,
        400,
        -32000,
        "Bad Request: no valid session, and request was not an initialize request.",
      );
      return;
    }

    await apiKeyOverrideStorage.run(presentedKey, () => transport.handleRequest(req, res, req.body));
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
        refuse(res, 500, -32603, "Internal server error");
      }
    });
  });

  app.delete("/mcp", (req, res) => {
    handleMcpRequest(req, res).catch((err) => {
      console.error("[courtmesh-mcp] Error handling DELETE /mcp:", err);
      if (!res.headersSent) {
        refuse(res, 500, -32603, "Internal server error");
      }
    });
  });

  // Anything else on this host is not a route. Answered in the same JSON-RPC
  // shape rather than by Express's default HTML page.
  app.use((_req: Request, res: Response) => {
    refuse(res, 404, -32601, "Not found.");
  });

  /*
   * TERMINAL ERROR HANDLER.
   *
   * Express's default handler renders an HTML page whose body is the stack
   * trace whenever NODE_ENV is not "production", and a malformed JSON body is
   * enough to reach it: express.json() throws a SyntaxError with status 400
   * before any route runs. That page disclosed the deploy user, the absolute
   * deploy path and the dependency tree to any anonymous caller.
   *
   * Setting NODE_ENV=production in pm2 also suppresses it, and it should be
   * set, but it is one environment variable away from coming back. This handler
   * is the thing that makes the disclosure structurally impossible: the body is
   * a fixed JSON-RPC error, the detail goes to stderr, and neither depends on
   * how the process happens to be launched.
   */
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    console.error("[courtmesh-mcp] Request error:", err?.message ?? err);
    if (res.headersSent) return next(err);
    if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
      return refuse(res, 400, -32700, "Parse error: the request body is not valid JSON.");
    }
    if (err?.type === "entity.too.large") {
      return refuse(res, 413, -32600, "Request body too large.");
    }
    return refuse(res, status, -32603, status >= 500 ? "Internal server error" : "Bad request.");
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

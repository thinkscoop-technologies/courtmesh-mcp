/**
 * End to end tests for the CourtMesh MCP server, driven through the real
 * @modelcontextprotocol/sdk Client over both transports (stdio and Streamable HTTP),
 * against a mock CourtMesh API (test/e2e/mock-api.mjs) built from the OpenAPI spec at
 * ../../../research/server/public-api/openapi.ts (dumped by dump-openapi.mjs into
 * test/e2e/openapi.json).
 *
 * The real CourtMesh API is not reachable from here, so nothing in this file ever
 * calls it: every HTTP request the MCP server makes lands on the mock, on loopback.
 *
 * Run: npm run test:e2e   (builds first, drives dist/index.js)
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startMockApi } from "./mock-api.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = path.join(ROOT, "dist/index.js");

// ---------------------------------------------------------------------------
// Expected tool surface
// ---------------------------------------------------------------------------

const EXPECTED_TOOLS = [
  "search_indian_court_cases",
  "semantic_search_cases",
  "get_case",
  "get_case_analysis",
  "find_related_cases",
  "search_judges",
  "analyze_case",
  "analyze_consolidated_case",
  "get_case_pdf_url",
  "request_case_timeline",
  "get_case_timeline",
  "screen_party_litigation",
  "get_court_coverage",
  "check_api_health",
];

// ---------------------------------------------------------------------------
// Process / client helpers
// ---------------------------------------------------------------------------

interface StdioHandle {
  client: Client;
  close(): Promise<void>;
}

/** Starts dist/index.js over stdio with the given extra env, wrapped in a connected SDK Client. */
async function startStdioClient(extraEnv: Record<string, string>): Promise<StdioHandle> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { ...(process.env as Record<string, string>), ...extraEnv },
    stderr: "ignore",
  });
  const client = new Client({ name: "e2e-test-client", version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}

interface HttpServerHandle {
  baseUrl: string;
  close(): Promise<void>;
}

/** Spawns dist/index.js --http as a child process, waits for /health, returns its base URL. */
async function startHttpServer(extraEnv: Record<string, string>): Promise<HttpServerHandle> {
  const port = 42000 + Math.floor(Math.random() * 4000);
  const child = spawnProcess(process.execPath, [ENTRY, "--http"], {
    env: { ...(process.env as Record<string, string>), PORT: String(port), ...extraEnv },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 100 && !up; i += 1) {
    try {
      up = (await fetch(`${baseUrl}/health`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(up, "MCP HTTP server did not start");
  return {
    baseUrl,
    async close() {
      child.kill("SIGKILL");
    },
  };
}

interface HttpClientOptions {
  bearer?: string;
  queryToken?: string;
}

async function connectHttpClient(baseUrl: string, opts: HttpClientOptions): Promise<Client> {
  const url = new URL(`${baseUrl}/mcp`);
  if (opts.queryToken) url.searchParams.set("token", opts.queryToken);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: opts.bearer ? { headers: { Authorization: `Bearer ${opts.bearer}` } } : undefined,
  });
  const client = new Client({ name: "e2e-http-test-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Extracts the joined text of every text content block in a tool result. */
function resultText(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((c: any) => c && c.type === "text")
    .map((c: any) => String(c.text))
    .join("\n");
}

/** No stack trace, no raw key material, in text shown to the calling model. */
function assertNonLeaking(text: string, forbiddenKeys: string[] = []) {
  assert.ok(typeof text === "string" && text.length > 0, "error text must be a non-empty string");
  assert.doesNotMatch(text, /\bat\s+\S+\s*\(.*:\d+:\d+\)/, "error text must not contain a stack frame");
  assert.doesNotMatch(text, /node_modules/, "error text must not leak a dependency path");
  assert.doesNotMatch(text, /\/Users\/|\/home\//, "error text must not leak a local filesystem path");
  for (const key of forbiddenKeys) {
    assert.ok(!text.includes(key), `error text must not echo the API key (${key})`);
  }
}

// ---------------------------------------------------------------------------
// Shared mock API instance for the whole file, plus one long lived stdio
// session (KEYS.valid) used for the handshake / schema / happy path tests.
// ---------------------------------------------------------------------------

// A single before/after pair for the whole file: node:test's top level before/after hooks
// are hooks on the implicit root suite, so registering more than one pair at different
// points in the file (rather than nesting each group under its own describe()) runs every
// hook before every top level test, not once each. One pair, doing all setup, avoids that.
let mock: Awaited<ReturnType<typeof startMockApi>>;
let stdioMain: StdioHandle;
let httpMain: HttpServerHandle;

test.before(async () => {
  mock = await startMockApi();
  stdioMain = await startStdioClient({
    COURTMESH_API_KEY: mock.KEYS.valid,
    COURTMESH_API_BASE_URL: mock.baseUrl,
  });
  httpMain = await startHttpServer({ COURTMESH_API_BASE_URL: mock.baseUrl });
});

test.after(async () => {
  await stdioMain.close();
  await httpMain.close();
  await mock.close();
});

function lastRequestMatching(pathPattern: RegExp, method?: string) {
  for (let i = mock.requests.length - 1; i >= 0; i -= 1) {
    const r = mock.requests[i];
    if (pathPattern.test(r.path) && (!method || r.method === method)) return r;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 1. Handshake, tools/list, schema shape
// ---------------------------------------------------------------------------

test("stdio: initialize handshake exposes exactly 14 tools with the documented names", async () => {
  const { tools } = await stdioMain.client.listTools();
  assert.equal(tools.length, 14, `expected 14 tools, got ${tools.length}: ${tools.map((t) => t.name).join(", ")}`);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
});

test("stdio: every tool's inputSchema is a valid JSON Schema object with the expected shape", async () => {
  const { tools } = await stdioMain.client.listTools();
  const byName: Record<string, any> = Object.fromEntries(tools.map((t) => [t.name, t]));

  for (const tool of tools) {
    assert.equal(tool.inputSchema?.type, "object", `${tool.name}.inputSchema.type must be "object"`);
    assert.ok(
      tool.inputSchema?.properties && typeof tool.inputSchema.properties === "object",
      `${tool.name}.inputSchema.properties must be an object`,
    );
  }

  // Required fields, spot checked on a representative sample.
  assert.deepEqual(byName.get_case.inputSchema.required, ["id"]);
  assert.deepEqual(byName.search_judges.inputSchema.required ?? [], []);
  const searchRequired = byName.search_indian_court_cases.inputSchema.required;
  assert.ok(Array.isArray(searchRequired) && searchRequired.includes("query"));

  const screenRequired = byName.screen_party_litigation.inputSchema.required;
  assert.ok(Array.isArray(screenRequired));
  for (const f of ["name", "entityType", "purpose"]) {
    assert.ok(screenRequired.includes(f), `screen_party_litigation.inputSchema.required must include "${f}"`);
  }

  // Enums for purpose and entityType.
  const screenProps = byName.screen_party_litigation.inputSchema.properties as Record<string, any>;
  assert.deepEqual([...screenProps.entityType.enum].sort(), ["company", "person"]);
  assert.deepEqual(
    [...screenProps.purpose.enum].sort(),
    ["bgv", "compliance", "due_diligence", "kyc", "litigation", "research"].sort(),
  );

  const searchProps = byName.search_indian_court_cases.inputSchema.properties as Record<string, any>;
  assert.deepEqual([...searchProps.sortBy.enum].sort(), ["date", "oldest", "recent", "relevance"].sort());
});

// ---------------------------------------------------------------------------
// 2. Every tool, called once with valid arguments, over stdio
// ---------------------------------------------------------------------------

test("stdio: search_indian_court_cases sends the documented POST and returns hits", async () => {
  const result = await stdioMain.client.callTool({
    name: "search_indian_court_cases",
    arguments: { query: "anticipatory bail section 438", limit: 20 },
  });
  const req = lastRequestMatching(/^\/search\/cases$/, "POST");
  assert.ok(req, "mock did not receive POST /search/cases");
  assert.equal(req!.body.query, "anticipatory bail section 438");
  assert.equal(req!.body.limit, 20);
  const text = resultText(result);
  assert.ok(text.includes("CRL.A. 1234/2023"), "result should include a real case number");
  assert.notEqual((result as any).isError, true);
});

test("stdio: semantic_search_cases sends the documented POST and returns hits", async () => {
  const result = await stdioMain.client.callTool({
    name: "semantic_search_cases",
    arguments: { query: "when can a court lift the corporate veil", limit: 5 },
  });
  const req = lastRequestMatching(/^\/search\/cases\/semantic$/, "POST");
  assert.ok(req, "mock did not receive POST /search/cases/semantic");
  assert.equal(req!.body.query, "when can a court lift the corporate veil");
  const text = resultText(result);
  assert.ok(text.includes("similarity"), "semantic search result should surface similarity scores");
  assert.notEqual((result as any).isError, true);
});

test("stdio: get_case fetches case details without triggering analysis", async () => {
  const result = await stdioMain.client.callTool({
    name: "get_case",
    arguments: { id: "64f1a2b3c4d5e6f7a8b9c0d1" },
  });
  const req = lastRequestMatching(/^\/cases\/64f1a2b3c4d5e6f7a8b9c0d1$/, "GET");
  assert.ok(req, "mock did not receive GET /cases/{id}");
  const text = resultText(result);
  assert.ok(text.includes("State of NCT of Delhi"));
  assert.notEqual((result as any).isError, true);
});

test("stdio: get_case_analysis reports hasAnalysis and the analysis body when present", async () => {
  const result = await stdioMain.client.callTool({
    name: "get_case_analysis",
    arguments: { id: "64f1a2b3c4d5e6f7a8b9c0d2" },
  });
  const req = lastRequestMatching(/^\/cases\/64f1a2b3c4d5e6f7a8b9c0d2\/analysis$/, "GET");
  assert.ok(req, "mock did not receive GET /cases/{id}/analysis");
  const text = resultText(result);
  assert.ok(text.includes("natural justice"), "analysis text should surface the holding");
  assert.notEqual((result as any).isError, true);
});

test("stdio: find_related_cases returns related documents and a timeline", async () => {
  const result = await stdioMain.client.callTool({
    name: "find_related_cases",
    arguments: { id: "64f1a2b3c4d5e6f7a8b9c0d1" },
  });
  const req = lastRequestMatching(/^\/cases\/64f1a2b3c4d5e6f7a8b9c0d1\/related$/, "GET");
  assert.ok(req);
  const text = resultText(result);
  assert.ok(text.includes("relatedDocuments"));
  assert.ok(text.includes("timeline"));
  assert.notEqual((result as any).isError, true);
});

test("stdio: search_judges resolves exact judge name spellings", async () => {
  const result = await stdioMain.client.callTool({
    name: "search_judges",
    arguments: { q: "chandrachud" },
  });
  const req = lastRequestMatching(/^\/judges\/search$/, "GET");
  assert.ok(req);
  assert.equal(req!.query.q, "chandrachud");
  const text = resultText(result);
  assert.ok(text.includes("CHANDRACHUD"));
  assert.notEqual((result as any).isError, true);
});

test("stdio: analyze_case starts background analysis (202) for a fresh case", async () => {
  const result = await stdioMain.client.callTool({
    name: "analyze_case",
    arguments: { id: "64f1a2b3c4d5e6f7a8b9c0d1" },
  });
  const req = lastRequestMatching(/^\/cases\/64f1a2b3c4d5e6f7a8b9c0d1\/analyze$/, "POST");
  assert.ok(req, "mock did not receive POST /cases/{id}/analyze");
  assert.equal(req!.body?.force ?? undefined, undefined, "force should be omitted when not requested");
  const text = resultText(result);
  assert.ok(text.includes("processing"));
  assert.notEqual((result as any).isError, true);
});

test("stdio: analyze_case returns the existing analysis inline when one already exists", async () => {
  const result = await stdioMain.client.callTool({
    name: "analyze_case",
    arguments: { id: "64f1a2b3c4d5e6f7a8b9c0d2" },
  });
  const text = resultText(result);
  assert.ok(text.includes("alreadyExists"));
  assert.notEqual((result as any).isError, true);
});

test("stdio: analyze_consolidated_case runs a merged analysis across the matter", async () => {
  const result = await stdioMain.client.callTool({
    name: "analyze_consolidated_case",
    arguments: { id: "64f1a2b3c4d5e6f7a8b9c0d1" },
  });
  const req = lastRequestMatching(/^\/cases\/64f1a2b3c4d5e6f7a8b9c0d1\/analyze-consolidated$/, "POST");
  assert.ok(req);
  const text = resultText(result);
  assert.ok(text.includes("success") || text.includes("already_analyzed"));
  assert.notEqual((result as any).isError, true);
});

test("stdio: get_case_pdf_url returns an opaque, time limited link", async () => {
  const result = await stdioMain.client.callTool({
    name: "get_case_pdf_url",
    arguments: { id: "64f1a2b3c4d5e6f7a8b9c0d1" },
  });
  const req = lastRequestMatching(/^\/cases\/64f1a2b3c4d5e6f7a8b9c0d1\/pdf$/, "GET");
  assert.ok(req);
  const text = resultText(result);
  assert.ok(text.includes("expiresIn"));
  assert.ok(text.includes("3600"));
  assert.notEqual((result as any).isError, true);
});

let capturedRequestId: string | undefined;

test("stdio: request_case_timeline kicks off a timeline job", async () => {
  const result = await stdioMain.client.callTool({
    name: "request_case_timeline",
    arguments: { case_id: "64f1a2b3c4d5e6f7a8b9c0d1" },
  });
  const req = lastRequestMatching(/^\/request-timeline$/, "POST");
  assert.ok(req);
  assert.equal(req!.body.case_id, "64f1a2b3c4d5e6f7a8b9c0d1");
  const text = resultText(result);
  const parsed = JSON.parse(text.slice(text.indexOf("{")));
  capturedRequestId = parsed.data?.requestId;
  assert.ok(typeof capturedRequestId === "string" && capturedRequestId.length > 0);
  assert.notEqual((result as any).isError, true);
});

test("stdio: get_case_timeline polls the job started above to completion", async () => {
  assert.ok(capturedRequestId, "previous test must have captured a requestId");
  const result = await stdioMain.client.callTool({
    name: "get_case_timeline",
    arguments: { requestId: capturedRequestId },
  });
  const req = lastRequestMatching(new RegExp(`^/get-timeline/${capturedRequestId}$`), "GET");
  assert.ok(req);
  const text = resultText(result);
  assert.ok(text.includes("completed"));
  assert.ok(text.includes("orderCount"));
  assert.notEqual((result as any).isError, true);
});

test("stdio: screen_party_litigation sends purpose, entityType, and defaults adjudicate to false", async () => {
  const result = await stdioMain.client.callTool({
    name: "screen_party_litigation",
    arguments: { name: "Ramesh Kumar", entityType: "person", purpose: "kyc" },
  });
  const req = lastRequestMatching(/^\/party\/screen$/, "POST");
  assert.ok(req, "mock did not receive POST /party/screen");
  assert.equal(req!.body.name, "Ramesh Kumar");
  assert.equal(req!.body.entityType, "person");
  assert.equal(req!.body.purpose, "kyc");
  assert.ok(
    req!.body.adjudicate === undefined || req!.body.adjudicate === false,
    "adjudicate must default to false (via omission, relying on the API's own default) when not requested",
  );
  const text = resultText(result);
  assert.ok(text.includes("verdict"));
  assert.ok(text.includes("creditsCharged"));
  assert.ok(text.includes("100"), "a match was found, so the base price of 100 credits should be reported");
  assert.notEqual((result as any).isError, true);
});

test("stdio: get_court_coverage requires no API key and returns corpus totals", async () => {
  const result = await stdioMain.client.callTool({ name: "get_court_coverage", arguments: {} });
  const req = lastRequestMatching(/^\/coverage$/, "GET");
  assert.ok(req);
  const text = resultText(result);
  assert.ok(text.includes("documentBearing"));
  assert.ok(text.includes("total"));
  assert.notEqual((result as any).isError, true);
});

test("stdio: get_court_coverage still succeeds with no API key configured at all", async () => {
  const noKeyClient = await startStdioClient({ COURTMESH_API_BASE_URL: mock.baseUrl, COURTMESH_API_KEY: "" });
  try {
    const result = await noKeyClient.client.callTool({ name: "get_court_coverage", arguments: {} });
    assert.notEqual((result as any).isError, true, "coverage must not require a key, per the API spec");
    const text = resultText(result);
    assert.ok(text.includes("documentBearing"));
  } finally {
    await noKeyClient.close();
  }
});

test("stdio: check_api_health reports the upstream API status", async () => {
  const result = await stdioMain.client.callTool({ name: "check_api_health", arguments: {} });
  const req = lastRequestMatching(/^\/health$/, "GET");
  assert.ok(req);
  const text = resultText(result);
  assert.ok(text.includes("healthy"));
  assert.notEqual((result as any).isError, true);
});

// ---------------------------------------------------------------------------
// 2b. New api-v1-validations.ts / api-tiers.ts contract fields: cursor, refresh,
//     allowRemoteFetch, and the semantic search top level filters.
// ---------------------------------------------------------------------------

test("stdio: search_indian_court_cases omits cursor by default and surfaces the opaque nextCursor", async () => {
  const result = await stdioMain.client.callTool({
    name: "search_indian_court_cases",
    arguments: { query: "anticipatory bail" },
  });
  const req = lastRequestMatching(/^\/search\/cases$/, "POST");
  assert.ok(req);
  assert.equal(req!.body.cursor, undefined, "cursor must be omitted when not supplied");
  const text = resultText(result);
  assert.ok(text.includes("cursor"), "pagination note should mention passing the value back as cursor");
  assert.notEqual((result as any).isError, true);
});

test("stdio: search_indian_court_cases forwards a supplied cursor verbatim", async () => {
  const result = await stdioMain.client.callTool({
    name: "search_indian_court_cases",
    arguments: { query: "anticipatory bail", cursor: "eyJzYSI6WyJtb2NrIl0.mocksignature" },
  });
  const req = lastRequestMatching(/^\/search\/cases$/, "POST");
  assert.ok(req);
  assert.equal(req!.body.cursor, "eyJzYSI6WyJtb2NrIl0.mocksignature");
  assert.notEqual((result as any).isError, true);
});

test("stdio: semantic_search_cases forwards the top level filters as real filters, not dropped", async () => {
  const result = await stdioMain.client.callTool({
    name: "semantic_search_cases",
    arguments: {
      query: "when can a court lift the corporate veil",
      court: "Delhi High Court",
      year: 2023,
      caseType: "WP(C)",
      caseNumber: "1234",
      judgeName: "D.Y. CHANDRACHUD",
      fromDate: "2020-01-01",
      toDate: "2023-12-31",
    },
  });
  const req = lastRequestMatching(/^\/search\/cases\/semantic$/, "POST");
  assert.ok(req);
  assert.equal(req!.body.court, "Delhi High Court");
  assert.equal(req!.body.year, 2023);
  assert.equal(req!.body.caseType, "WP(C)");
  assert.equal(req!.body.caseNumber, "1234");
  assert.equal(req!.body.judgeName, "D.Y. CHANDRACHUD");
  assert.equal(req!.body.fromDate, "2020-01-01");
  assert.equal(req!.body.toDate, "2023-12-31");
  assert.notEqual((result as any).isError, true);
});

test("stdio: semantic_search_cases rejects a caseNumber that is not digits only", async () => {
  const result = await stdioMain.client.callTool({
    name: "semantic_search_cases",
    arguments: { query: "corporate veil doctrine", caseNumber: "WP(C) 123/2024" },
  });
  assert.equal((result as any).isError, true);
  assertNonLeaking(resultText(result));
});

test("stdio: semantic_search_cases rejects more than one judge name", async () => {
  const result = await stdioMain.client.callTool({
    name: "semantic_search_cases",
    arguments: { query: "corporate veil doctrine", judgeName: ["Judge A", "Judge B"] },
  });
  assert.equal((result as any).isError, true);
  assertNonLeaking(resultText(result));
});

test("stdio: request_case_timeline defaults to a stored read (refresh omitted, meta.liveFetch false)", async () => {
  const result = await stdioMain.client.callTool({
    name: "request_case_timeline",
    arguments: { case_id: "64f1a2b3c4d5e6f7a8b9c0d1" },
  });
  const req = lastRequestMatching(/^\/request-timeline$/, "POST");
  assert.ok(req);
  assert.equal(req!.body.refresh, undefined, "refresh must be omitted when not requested");
  const text = resultText(result);
  assert.match(text, /"liveFetch":\s*false/);
  assert.notEqual((result as any).isError, true);
});

test("stdio: request_case_timeline sends refresh true and surfaces meta.liveFetch true", async () => {
  const result = await stdioMain.client.callTool({
    name: "request_case_timeline",
    arguments: { case_id: "64f1a2b3c4d5e6f7a8b9c0d1", refresh: true },
  });
  const req = lastRequestMatching(/^\/request-timeline$/, "POST");
  assert.ok(req);
  assert.equal(req!.body.refresh, true);
  const text = resultText(result);
  assert.match(text, /"liveFetch":\s*true/);
  assert.notEqual((result as any).isError, true);
});

test("stdio: analyze_case forwards allowRemoteFetch true", async () => {
  const result = await stdioMain.client.callTool({
    name: "analyze_case",
    arguments: { id: "64f1a2b3c4d5e6f7a8b9c0d1", allowRemoteFetch: true },
  });
  const req = lastRequestMatching(/^\/cases\/64f1a2b3c4d5e6f7a8b9c0d1\/analyze$/, "POST");
  assert.ok(req);
  assert.equal(req!.body.allowRemoteFetch, true);
  assert.notEqual((result as any).isError, true);
});

test("stdio: analyze_case omits allowRemoteFetch by default", async () => {
  const result = await stdioMain.client.callTool({
    name: "analyze_case",
    arguments: { id: "64f1a2b3c4d5e6f7a8b9c0d2" },
  });
  const req = lastRequestMatching(/^\/cases\/64f1a2b3c4d5e6f7a8b9c0d2\/analyze$/, "POST");
  assert.ok(req);
  assert.equal(req!.body.allowRemoteFetch, undefined);
  assert.notEqual((result as any).isError, true);
});

test("stdio: get_case_pdf_url distinguishes PDF_NOT_STORED from CASE_NOT_FOUND, with the hint", async () => {
  const result = await stdioMain.client.callTool({
    name: "get_case_pdf_url",
    arguments: { id: "64f1a2b3c4d5e6f7a8b9c0d3" },
  });
  assert.equal((result as any).isError, true);
  const text = resultText(result);
  assert.match(text, /PDF_NOT_STORED/);
  assert.match(text, /request-timeline/i);
});

test("stdio: get_case_pdf_url reports CASE_NOT_FOUND for an id matching no case", async () => {
  const result = await stdioMain.client.callTool({
    name: "get_case_pdf_url",
    arguments: { id: "000000000000000000000000" },
  });
  assert.equal((result as any).isError, true);
  const text = resultText(result);
  assert.match(text, /CASE_NOT_FOUND|Case not found/);
});

test("stdio: screen_party_litigation rejects limit above 100", async () => {
  const result = await stdioMain.client.callTool({
    name: "screen_party_litigation",
    arguments: { name: "Ramesh Kumar", entityType: "person", purpose: "kyc", limit: 101 },
  });
  assert.equal((result as any).isError, true);
  assertNonLeaking(resultText(result));
});

test("stdio: screen_party_litigation rejects a displayThreshold outside 0 to 1", async () => {
  const result = await stdioMain.client.callTool({
    name: "screen_party_litigation",
    arguments: { name: "Ramesh Kumar", entityType: "person", purpose: "kyc", displayThreshold: 1.5 },
  });
  assert.equal((result as any).isError, true);
  assertNonLeaking(resultText(result));
});

test("stdio: screen_party_litigation rejects more than 10 knownPersons", async () => {
  const result = await stdioMain.client.callTool({
    name: "screen_party_litigation",
    arguments: {
      name: "Ramesh Kumar",
      entityType: "person",
      purpose: "kyc",
      knownPersons: Array.from({ length: 11 }, (_, i) => `Person ${i}`),
    },
  });
  assert.equal((result as any).isError, true);
  assertNonLeaking(resultText(result));
});

test("stdio: screen_party_litigation rejects more than one court", async () => {
  const result = await stdioMain.client.callTool({
    name: "screen_party_litigation",
    arguments: { name: "Ramesh Kumar", entityType: "person", purpose: "kyc", court: ["Delhi High Court", "Bombay High Court"] },
  });
  assert.equal((result as any).isError, true);
  assertNonLeaking(resultText(result));
});

test("stdio: screen_party_litigation accepts a single element court array", async () => {
  const result = await stdioMain.client.callTool({
    name: "screen_party_litigation",
    arguments: { name: "Ramesh Kumar", entityType: "person", purpose: "kyc", court: ["Delhi High Court"] },
  });
  const req = lastRequestMatching(/^\/party\/screen$/, "POST");
  assert.ok(req);
  assert.deepEqual(req!.body.court, ["Delhi High Court"]);
  assert.notEqual((result as any).isError, true);
});

// ---------------------------------------------------------------------------
// 3. Invalid arguments produce a proper MCP error, not a crash
//
// This SDK version (1.30.0) deliberately catches the McpError thrown by its own
// input-schema validation and converts it into a normal CallToolResult with
// isError: true (see validateToolInput/createToolError in
// @modelcontextprotocol/sdk/dist/esm/server/mcp.js), rather than rejecting the
// tools/call request at the JSON-RPC protocol level. That is the "not a crash"
// contract in practice: the calling model sees a clear, recoverable tool error
// instead of the whole turn failing. Confirmed against the real SDK below rather
// than assumed.
// ---------------------------------------------------------------------------

test("stdio: missing required argument comes back as a clear tool error, not a crash", async () => {
  const result = await stdioMain.client.callTool({ name: "search_indian_court_cases", arguments: {} as any });
  assert.equal((result as any).isError, true);
  const text = resultText(result);
  assert.match(text, /Invalid arguments|Required|query/i);
  assertNonLeaking(text);
});

test("stdio: an invalid enum value comes back as a clear tool error, not a crash", async () => {
  const result = await stdioMain.client.callTool({
    name: "screen_party_litigation",
    arguments: { name: "Acme Ltd", entityType: "organization", purpose: "kyc" } as any,
  });
  assert.equal((result as any).isError, true);
  const text = resultText(result);
  assert.match(text, /Invalid arguments|entityType|enum/i);
  assertNonLeaking(text);
});

test("stdio: missing required purpose on screen_party_litigation comes back as a clear tool error", async () => {
  const result = await stdioMain.client.callTool({
    name: "screen_party_litigation",
    arguments: { name: "Acme Ltd", entityType: "company" } as any,
  });
  assert.equal((result as any).isError, true);
  const text = resultText(result);
  assert.match(text, /Invalid arguments|purpose|Required/i);
  assertNonLeaking(text);
});

test("stdio: an unknown tool name comes back as a clear tool error, not a crash", async () => {
  const result = await stdioMain.client.callTool({ name: "not_a_real_tool", arguments: {} });
  assert.equal((result as any).isError, true);
  assert.match(resultText(result), /not found/i);
});

test("stdio: the server process survives invalid arguments and keeps answering", async () => {
  const { tools } = await stdioMain.client.listTools();
  assert.equal(tools.length, 14, "server must still respond normally after a rejected call");
});

// ---------------------------------------------------------------------------
// 4. Scripted error scenarios over stdio (one short lived process per key,
//    since the stdio transport's key is fixed for the process lifetime)
// ---------------------------------------------------------------------------

async function withScenarioStdio(apiKey: string, extraEnv: Record<string, string> = {}) {
  return startStdioClient({
    COURTMESH_API_KEY: apiKey,
    COURTMESH_API_BASE_URL: mock.baseUrl,
    ...extraEnv,
  });
}

test("stdio: an unrecognised (well formed) API key produces a clear 401, not a crash", async () => {
  const handle = await withScenarioStdio(mock.KEYS.unknown);
  try {
    const result = await handle.client.callTool({
      name: "search_indian_court_cases",
      arguments: { query: "test" },
    });
    assert.equal((result as any).isError, true);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.unknown]);
    assert.match(text, /401|Authentication failed/i);
    // Process must still be alive and answering.
    const { tools } = await handle.client.listTools();
    assert.equal(tools.length, 14);
  } finally {
    await handle.close();
  }
});

test("stdio: insufficient credits (402) on screen_party_litigation surfaces the real numbers", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenario402);
  try {
    const result = await handle.client.callTool({
      name: "screen_party_litigation",
      arguments: { name: "Ramesh Kumar", entityType: "person", purpose: "kyc" },
    });
    assert.equal((result as any).isError, true);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenario402]);
    // Required/balance/shortfall must be the REAL numbers from the API body, not "unknown":
    // this exercises the client.ts fix for the requiredCredits -> required field name bug.
    assert.match(text, /Required:\s*100/);
    assert.match(text, /Balance:\s*42/);
    assert.match(text, /Shortfall:\s*58/);
    assert.match(text, /Top up at:.*api-keys#credits/);
    const { tools } = await handle.client.listTools();
    assert.equal(tools.length, 14, "process must survive a 402");
  } finally {
    await handle.close();
  }
});

test("stdio: free tier AI lockout (403 API_TIER_NOT_ALLOWED) surfaces the upgrade URL", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenario403Tier);
  try {
    const result = await handle.client.callTool({
      name: "get_case_analysis",
      arguments: { id: "64f1a2b3c4d5e6f7a8b9c0d1" },
    });
    assert.equal((result as any).isError, true);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenario403Tier]);
    assert.match(text, /403/);
    assert.match(text, /Upgrade at:.*api-keys#credits/);
  } finally {
    await handle.close();
  }
});

test("stdio: party screen monthly cap (403 PARTY_SCREEN_LIMIT_REACHED) is clearly reported", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenario403PartyLimit);
  try {
    const result = await handle.client.callTool({
      name: "screen_party_litigation",
      arguments: { name: "Ramesh Kumar", entityType: "person", purpose: "kyc" },
    });
    assert.equal((result as any).isError, true);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenario403PartyLimit]);
    assert.match(text, /403/);
    assert.match(text, /Monthly party screen limit reached/);
  } finally {
    await handle.close();
  }
});

test("stdio: 429 rate limit on a POST tool reports the retry window and is NOT retried", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenario429);
  try {
    // search_indian_court_cases is POST /search/cases; the mock's scenario429 always answers
    // 429 with a 37 second Retry-After. If this client retried a POST the way it now retries a
    // GET, this call would hang for up to 37s (capped at 60s) before failing - it must instead
    // fail immediately, proving POST is never retried.
    const start = Date.now();
    const result = await handle.client.callTool({
      name: "search_indian_court_cases",
      arguments: { query: "test" },
    });
    const elapsed = Date.now() - start;
    assert.equal((result as any).isError, true);
    assert.ok(elapsed < 5_000, `expected an immediate failure with no retry, took ${elapsed}ms`);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenario429]);
    assert.match(text, /Rate limited/i);
    assert.match(text, /Retry after 37 seconds/);
  } finally {
    await handle.close();
  }
});

test("stdio: 429 RATE_LIMITED on a GET tool is retried once and succeeds", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenario429GetRetry);
  try {
    // get_court_coverage is GET /coverage; the mock's scenario429-get-retry answers 429
    // RATE_LIMITED (Retry-After: 1) on the first request from this key, then 200 on every
    // request after that - this proves the client's single bounded GET retry actually runs
    // and recovers, not just that it declines to retry (covered by the POST test above).
    const requestsBefore = mock.requests.length;
    const result = await handle.client.callTool({ name: "get_court_coverage", arguments: {} });
    assert.notEqual((result as any).isError, true, `expected the retried call to succeed: ${resultText(result)}`);
    const coverageRequestsDuring = mock.requests.slice(requestsBefore).filter((r) => r.path === "/coverage");
    // Two requests reached the mock for this one tool call: the initial 429 and the one retry.
    assert.equal(coverageRequestsDuring.length, 2, `expected exactly 2 requests to /coverage (429 then retry), saw ${coverageRequestsDuring.length}`);
  } finally {
    await handle.close();
  }
});

test("stdio: 403 REMOTE_FETCH_NOT_ALLOWED on analyze_case names the flag to send", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenarioRemoteFetchNotAllowed);
  try {
    const result = await handle.client.callTool({
      name: "analyze_case",
      arguments: { id: "64f1a2b3c4d5e6f7a8b9c0d1" },
    });
    assert.equal((result as any).isError, true);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenarioRemoteFetchNotAllowed]);
    assert.match(text, /REMOTE_FETCH_NOT_ALLOWED|allowRemoteFetch/);
  } finally {
    await handle.close();
  }
});

test("stdio: 403 LIVE_FETCH_NOT_ALLOWED on request_case_timeline refresh:true names the flag to drop", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenarioLiveFetchNotAllowed);
  try {
    const result = await handle.client.callTool({
      name: "request_case_timeline",
      arguments: { case_id: "64f1a2b3c4d5e6f7a8b9c0d1", refresh: true },
    });
    assert.equal((result as any).isError, true);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenarioLiveFetchNotAllowed]);
    assert.match(text, /LIVE_FETCH_NOT_ALLOWED|refresh/i);
  } finally {
    await handle.close();
  }
});

test("stdio: 429 LIVE_FETCH_LIMIT_REACHED on request_case_timeline reports the retry window", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenarioLiveFetchLimit);
  try {
    const result = await handle.client.callTool({
      name: "request_case_timeline",
      arguments: { case_id: "64f1a2b3c4d5e6f7a8b9c0d1", refresh: true },
    });
    assert.equal((result as any).isError, true);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenarioLiveFetchLimit]);
    assert.match(text, /Rate limited/i);
    assert.match(text, /200 per day/);
  } finally {
    await handle.close();
  }
});

test("stdio: 403 SEMANTIC_NOT_ALLOWED on semantic_search_cases points at the upgrade URL", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenarioSemanticNotAllowed);
  try {
    const result = await handle.client.callTool({
      name: "semantic_search_cases",
      arguments: { query: "when can a court lift the corporate veil" },
    });
    assert.equal((result as any).isError, true);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenarioSemanticNotAllowed]);
    assert.match(text, /SEMANTIC_NOT_ALLOWED/);
    assert.match(text, /Upgrade at:/);
  } finally {
    await handle.close();
  }
});

test("stdio: 429 TOO_MANY_KEYS_FROM_IP is clearly reported", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenarioTooManyKeys);
  try {
    const result = await handle.client.callTool({
      name: "search_indian_court_cases",
      arguments: { query: "test" },
    });
    assert.equal((result as any).isError, true);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenarioTooManyKeys]);
    assert.match(text, /TOO_MANY_KEYS_FROM_IP|different API keys/i);
  } finally {
    await handle.close();
  }
});

test("stdio: 429 DISTINCT_CASES_LIMIT_REACHED is clearly reported", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenarioDistinctCases);
  try {
    const result = await handle.client.callTool({
      name: "get_case",
      arguments: { id: "64f1a2b3c4d5e6f7a8b9c0d1" },
    });
    assert.equal((result as any).isError, true);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenarioDistinctCases]);
    assert.match(text, /DISTINCT_CASES_LIMIT_REACHED|distinct case detail fetches/i);
  } finally {
    await handle.close();
  }
});

test("stdio: 400 CURSOR_INVALID on search_indian_court_cases is reported as a cursor problem, not a tier cap", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenarioCursorInvalid);
  try {
    const result = await handle.client.callTool({
      name: "search_indian_court_cases",
      arguments: { query: "test", cursor: "stale-or-tampered-cursor" },
    });
    assert.equal((result as any).isError, true);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenarioCursorInvalid]);
    assert.match(text, /CURSOR_INVALID/);
    assert.doesNotMatch(text, /plan tier allows/, "must not be misreported as the PAGE_LIMIT_EXCEEDED shape");
    assert.match(text, /without a cursor/);
  } finally {
    await handle.close();
  }
});

test("stdio: 429 DISTINCT_NAMES_LIMIT_REACHED reports the distinct-names message", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenario429Distinct);
  try {
    const result = await handle.client.callTool({
      name: "screen_party_litigation",
      arguments: { name: "Someone New", entityType: "person", purpose: "kyc" },
    });
    assert.equal((result as any).isError, true);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenario429Distinct]);
    assert.match(text, /distinct names per day/i);
  } finally {
    await handle.close();
  }
});

test("stdio: 400 tier-cap-exceeded is reported as a plan limit, not a generic validation failure", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenario400TierCap);
  try {
    const result = await handle.client.callTool({
      name: "search_indian_court_cases",
      arguments: { query: "test", limit: 100 },
    });
    assert.equal((result as any).isError, true);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenario400TierCap]);
    assert.match(text, /PAGE_LIMIT_EXCEEDED/);
    assert.match(text, /free/);
  } finally {
    await handle.close();
  }
});

test("stdio: 503 is reported as a plain upstream failure", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenario503);
  try {
    const result = await handle.client.callTool({ name: "get_court_coverage", arguments: {} });
    assert.equal((result as any).isError, true);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenario503]);
    assert.match(text, /503/);
  } finally {
    await handle.close();
  }
});

test("stdio: a malformed-JSON 200 body is reported as an error, not returned as silent success", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenarioMalformed);
  try {
    const result = await handle.client.callTool({ name: "get_court_coverage", arguments: {} });
    assert.equal((result as any).isError, true, "a body that fails to parse as JSON must not be treated as success");
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenarioMalformed]);
    assert.match(text, /not valid JSON/);
  } finally {
    await handle.close();
  }
});

test("stdio: a hanging upstream aborts within the client's own timeout instead of hanging forever", async () => {
  const handle = await withScenarioStdio(mock.KEYS.scenarioTimeout, {
    COURTMESH_DEFAULT_TIMEOUT_MS: "1500",
    COURTMESH_LONG_TIMEOUT_MS: "1500",
  });
  try {
    const start = Date.now();
    const result = await handle.client.callTool({ name: "get_court_coverage", arguments: {} });
    const elapsed = Date.now() - start;
    assert.equal((result as any).isError, true);
    assert.ok(elapsed < 10_000, `expected the abort well under 10s (mock hangs 35s), took ${elapsed}ms`);
    const text = resultText(result);
    assertNonLeaking(text, [mock.KEYS.scenarioTimeout]);
    assert.match(text, /timed out/i);
    // Process must still be alive and answering after an abort.
    const { tools } = await handle.client.listTools();
    assert.equal(tools.length, 14);
  } finally {
    await handle.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Streamable HTTP transport: repeat the essentials, plus auth specific cases
// ---------------------------------------------------------------------------
// (httpMain is started in the single test.before() above.)

test("http: GET /health on the MCP server itself is unauthenticated and reports ok", async () => {
  const res = await fetch(`${httpMain.baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
});

test("http: an unauthenticated /mcp request is refused with the documented 401", async () => {
  const res = await fetch(`${httpMain.baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, -32001);
  assert.doesNotMatch(JSON.stringify(body), /node_modules|\/Users\//);
});

test("http: Authorization: Bearer with a valid key connects and lists 14 tools", async () => {
  const client = await connectHttpClient(httpMain.baseUrl, { bearer: mock.KEYS.valid });
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 14);
  } finally {
    await client.close();
  }
});

test("http: ?token= query parameter is honoured as an alternative to the header", async () => {
  const client = await connectHttpClient(httpMain.baseUrl, { queryToken: mock.KEYS.valid });
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 14);
    const result = await client.callTool({ name: "get_court_coverage", arguments: {} });
    assert.notEqual((result as any).isError, true);
  } finally {
    await client.close();
  }
});

test("http: every one of the 14 tools works over the HTTP transport with a valid key", async () => {
  const client = await connectHttpClient(httpMain.baseUrl, { bearer: mock.KEYS.valid });
  try {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["search_indian_court_cases", { query: "arbitration award" }],
      ["semantic_search_cases", { query: "medical negligence standard of care" }],
      ["get_case", { id: "64f1a2b3c4d5e6f7a8b9c0d1" }],
      ["get_case_analysis", { id: "64f1a2b3c4d5e6f7a8b9c0d2" }],
      ["find_related_cases", { id: "64f1a2b3c4d5e6f7a8b9c0d1" }],
      ["search_judges", { q: "chandrachud" }],
      ["analyze_case", { id: "64f1a2b3c4d5e6f7a8b9c0d1" }],
      ["analyze_consolidated_case", { id: "64f1a2b3c4d5e6f7a8b9c0d2" }],
      ["get_case_pdf_url", { id: "64f1a2b3c4d5e6f7a8b9c0d1" }],
      ["get_court_coverage", {}],
      ["check_api_health", {}],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual((result as any).isError, true, `${name} unexpectedly errored over HTTP: ${resultText(result)}`);
    }

    const timelineResult = await client.callTool({
      name: "request_case_timeline",
      arguments: { case_id: "64f1a2b3c4d5e6f7a8b9c0d1" },
    });
    assert.notEqual((timelineResult as any).isError, true);
    const text = resultText(timelineResult);
    const parsed = JSON.parse(text.slice(text.indexOf("{")));
    const requestId = parsed.data?.requestId;
    assert.ok(requestId);

    const pollResult = await client.callTool({ name: "get_case_timeline", arguments: { requestId } });
    assert.notEqual((pollResult as any).isError, true);

    const screenResult = await client.callTool({
      name: "screen_party_litigation",
      arguments: { name: "Ramesh Kumar", entityType: "person", purpose: "kyc" },
    });
    assert.notEqual((screenResult as any).isError, true);
  } finally {
    await client.close();
  }
});

test("http: scripted error scenarios also work, selected per session via the bearer token", async () => {
  const scenarios: Array<[string, string, string, Record<string, unknown>, RegExp]> = [
    ["402 insufficient credits", mock.KEYS.scenario402, "screen_party_litigation", { name: "Ramesh Kumar", entityType: "person", purpose: "kyc" }, /Required:\s*100/],
    ["403 tier lockout", mock.KEYS.scenario403Tier, "analyze_case", { id: "64f1a2b3c4d5e6f7a8b9c0d1" }, /Upgrade at:/],
    ["403 party screen limit", mock.KEYS.scenario403PartyLimit, "screen_party_litigation", { name: "Ramesh Kumar", entityType: "person", purpose: "kyc" }, /PARTY_SCREEN_LIMIT_REACHED|Monthly party screen limit/],
    ["429 rate limited", mock.KEYS.scenario429, "search_indian_court_cases", { query: "test" }, /Rate limited/i],
    ["503 unavailable", mock.KEYS.scenario503, "get_court_coverage", {}, /503/],
    ["malformed json", mock.KEYS.scenarioMalformed, "get_court_coverage", {}, /not valid JSON/],
  ];

  for (const [label, key, toolName, args, pattern] of scenarios) {
    const client = await connectHttpClient(httpMain.baseUrl, { bearer: key });
    try {
      const result = await client.callTool({ name: toolName, arguments: args });
      assert.equal((result as any).isError, true, `${label}: expected an error result`);
      const text = resultText(result);
      assertNonLeaking(text, [key]);
      assert.match(text, pattern, `${label}: error text did not match ${pattern}`);
    } finally {
      await client.close();
    }
  }
});

test("http: a hanging upstream aborts within a short client timeout on this transport too", async () => {
  const timeoutServer = await startHttpServer({
    COURTMESH_API_BASE_URL: mock.baseUrl,
    COURTMESH_DEFAULT_TIMEOUT_MS: "1500",
    COURTMESH_LONG_TIMEOUT_MS: "1500",
  });
  try {
    const client = await connectHttpClient(timeoutServer.baseUrl, { bearer: mock.KEYS.scenarioTimeout });
    try {
      const start = Date.now();
      const result = await client.callTool({ name: "get_court_coverage", arguments: {} });
      const elapsed = Date.now() - start;
      assert.equal((result as any).isError, true);
      assert.ok(elapsed < 10_000, `expected the abort well under 10s, took ${elapsed}ms`);
      const text = resultText(result);
      assertNonLeaking(text, [mock.KEYS.scenarioTimeout]);
      assert.match(text, /timed out/i);
    } finally {
      await client.close();
    }
  } finally {
    await timeoutServer.close();
  }
});

// ---------------------------------------------------------------------------
// 6. README configuration snippets: syntactically valid JSON, right package name
// ---------------------------------------------------------------------------

test("README: every fenced json config block is valid JSON naming the real package", async () => {
  const fs = await import("node:fs/promises");
  const readmeText = await fs.readFile(path.join(ROOT, "README.md"), "utf8");
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));

  const blocks = [...readmeText.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 4, `expected at least 4 fenced json blocks in README.md, found ${blocks.length}`);

  let sawNpxConfig = false;
  for (const raw of blocks) {
    let parsed: any;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(raw);
    }, `README.md contains a fenced json block that is not valid JSON:\n${raw}`);

    const server = parsed?.mcpServers?.courtmesh;
    if (!server) continue;

    if (Array.isArray(server.args)) {
      const pkgArg = server.args.find((a: string) => typeof a === "string" && a.includes("@courtmesh/mcp-server"));
      if (pkgArg) {
        sawNpxConfig = true;
        assert.equal(pkgArg, pkg.name, `README npx arg "${pkgArg}" must reference the package name exactly ("${pkg.name}"), with no stale version pin`);
      }
    }
    if (typeof server.url === "string" && server.url.includes("courtmesh")) {
      assert.match(server.url, /\/mcp(\?|$)/, "hosted HTTP config URL must point at the /mcp route");
    }
  }
  assert.ok(sawNpxConfig, "expected at least one README config block using npx @courtmesh/mcp-server");
});

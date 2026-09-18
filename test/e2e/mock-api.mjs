#!/usr/bin/env node
/**
 * Mock CourtMesh public API server, driven by the real OpenAPI spec and its examples
 * (see dump-openapi.mjs / openapi.json, sourced from
 * ../../../research/server/public-api/openapi.ts).
 *
 * Serves /api/v1/prod/* on a random loopback port with realistic response shapes for
 * all 18 documented endpoints, plus scripted error modes.
 *
 * Scenario selection
 * -------------------
 * The real MCP server (src/client.ts) only ever sends three headers upstream: Accept,
 * X-API-Key (when a key is configured) and Content-Type (when there is a body). It has
 * no mechanism to forward an arbitrary custom header from a tool call down to the HTTP
 * request. So a scenario can be selected two ways:
 *
 *   1. Directly, with the `X-Mock-Scenario` header, for tests that talk to this mock
 *      over plain fetch.
 *   2. Indirectly, by presenting one of the SCENARIO_KEYS below as the API key (either
 *      X-API-Key or Authorization: Bearer). This is how the end to end suite drives
 *      every error path through the real MCP server: it configures COURTMESH_API_KEY
 *      (stdio) or the per session ?token=/Authorization value (HTTP transport) to one
 *      of these keys, and this mock recognises the key and answers accordingly. Every
 *      key is a syntactically valid CourtMesh key (matches API_KEY_PATTERN in
 *      src/client.ts) so it passes the MCP server's own format check.
 *
 * The header always wins when both are present. Any other well formed key is treated as
 * the single "valid" credential and gets realistic 200 responses; an absent key, or one
 * that isn't a recognised format, gets a 401 on every endpoint that requires auth
 * (everything except /health and /coverage, matching the real API).
 *
 * Every request is recorded (method, path, query, headers with the key redacted, parsed
 * body) so tests can assert on exactly what the MCP server sent upstream.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Scenario keys
// ---------------------------------------------------------------------------

function makeKey(label) {
  const body = (label.replace(/[^A-Za-z0-9]/g, "") + "x".repeat(32)).slice(0, 32);
  return `cm-${body}-abcd`;
}

export const KEYS = {
  valid: makeKey("valid"),
  unknown: makeKey("unknownnotregistered"),
  scenario402: makeKey("scenario402credits"),
  scenario403Tier: makeKey("scenario403tierlock"),
  scenario403PartyLimit: makeKey("scenario403partylim"),
  scenario403Enterprise: makeKey("scenario403enterpris"),
  scenario429: makeKey("scenario429ratelimit"),
  scenario429Distinct: makeKey("scenario429distinct"),
  scenario503: makeKey("scenario503downstream"),
  scenarioTimeout: makeKey("scenariotimeoutslow"),
  scenarioMalformed: makeKey("scenariomalformedjson"),
  scenario400TierCap: makeKey("scenario400tiercap"),
  // Added for the api-v1-validations.ts / api-tiers.ts contract refresh: cursor,
  // refresh, allowRemoteFetch and the abuse-control-pass refusal codes.
  scenarioCursorInvalid: makeKey("scenariocursorinvalid"),
  scenarioRemoteFetchNotAllowed: makeKey("scenarioremotefetchna"),
  scenarioLiveFetchNotAllowed: makeKey("scenariolivefetchna"),
  scenarioLiveFetchLimit: makeKey("scenariolivefetchlimit"),
  scenarioSemanticNotAllowed: makeKey("scenariosemanticna"),
  scenarioTooManyKeys: makeKey("scenariotoomanykeys"),
  scenarioDistinctCases: makeKey("scenariodistinctcases"),
  scenario429GetRetry: makeKey("scenario429getretry"),
};

const KEY_SCENARIO_MAP = {
  [KEYS.scenario402]: "402",
  [KEYS.scenario403Tier]: "403-tier",
  [KEYS.scenario403PartyLimit]: "403-partylimit",
  [KEYS.scenario403Enterprise]: "403-enterprise",
  [KEYS.scenario429]: "429",
  [KEYS.scenario429Distinct]: "429-distinct",
  [KEYS.scenario503]: "503",
  [KEYS.scenarioTimeout]: "timeout",
  [KEYS.scenarioMalformed]: "malformed-json",
  [KEYS.scenario400TierCap]: "400-tiercap",
  [KEYS.scenarioCursorInvalid]: "cursor-invalid",
  [KEYS.scenarioRemoteFetchNotAllowed]: "remote-fetch-not-allowed",
  [KEYS.scenarioLiveFetchNotAllowed]: "live-fetch-not-allowed",
  [KEYS.scenarioLiveFetchLimit]: "live-fetch-limit",
  [KEYS.scenarioSemanticNotAllowed]: "semantic-not-allowed",
  [KEYS.scenarioTooManyKeys]: "too-many-keys",
  [KEYS.scenarioDistinctCases]: "distinct-cases-limit",
  [KEYS.scenario429GetRetry]: "429-get-retry",
};

const KNOWN_KEYS = new Set([KEYS.valid, ...Object.keys(KEY_SCENARIO_MAP)]);

// ---------------------------------------------------------------------------
// Fixed case fixtures, referenced by id across several endpoints
// ---------------------------------------------------------------------------

export const CASE_PENDING = {
  id: "64f1a2b3c4d5e6f7a8b9c0d1",
  caseNumber: "CRL.A. 1234/2023",
  title: "State of NCT of Delhi vs Ramesh Kumar",
  court: "Delhi High Court",
  caseType: "CRL.A.",
  judges: ["HON'BLE MR. JUSTICE D.Y. CHANDRACHUD"],
  petitioners: ["State of NCT of Delhi"],
  respondents: ["Ramesh Kumar"],
  decisionDate: "2023-08-14",
  disposalNature: "Dismissed",
  summary: "Appeal against acquittal in a criminal matter concerning anticipatory bail under section 438.",
  metadata: { diaryNumber: "12345/2023" },
  hasDocuments: true,
  documentCount: 3,
  hasAnalysis: false,
};

export const CASE_ANALYZED = {
  id: "64f1a2b3c4d5e6f7a8b9c0d2",
  caseNumber: "CRL.A. 5678/2022",
  title: "Acme Infrastructure Pvt Ltd vs Union of India",
  court: "Supreme Court of India",
  caseType: "CRL.A.",
  judges: ["HON'BLE MR. JUSTICE Y.V. CHANDRACHUD"],
  petitioners: ["Acme Infrastructure Private Limited"],
  respondents: ["Union of India"],
  decisionDate: "2022-11-02",
  disposalNature: "Allowed",
  summary: "Constitutional challenge to a regulatory order affecting eligibility for government contracts.",
  hasDocuments: true,
  documentCount: 1,
  hasAnalysis: true,
};

// A case that exists (so GET /cases/{id} and friends resolve it) but has no stored PDF, to
// distinguish PDF_NOT_STORED (this case) from CASE_NOT_FOUND (an id matching no case at all)
// on GET /cases/{id}/pdf.
export const CASE_NO_DOCS = {
  id: "64f1a2b3c4d5e6f7a8b9c0d3",
  caseNumber: "WP(C) 999/2024",
  title: "Kavita Sharma vs Municipal Corporation",
  court: "Bombay High Court",
  caseType: "WP(C)",
  judges: ["HON'BLE MS. JUSTICE INDIRA BANERJEE"],
  petitioners: ["Kavita Sharma"],
  respondents: ["Municipal Corporation"],
  decisionDate: "2024-02-20",
  disposalNature: "Pending",
  summary: "Writ petition concerning a municipal demolition notice, status-only record with no document indexed yet.",
  hasDocuments: false,
  documentCount: 0,
  hasAnalysis: false,
};

const ANALYSIS_BODY = {
  summary: "The Court allowed the appeal, holding that the impugned order violated principles of natural justice.",
  detailedSummary:
    "The petitioner was blacklisted from government contracts without notice or an opportunity to be heard. " +
    "The Court held this violated Article 14 and set aside the order.",
  headnote: "Natural justice - Administrative action with civil consequences - Notice mandatory.",
  holding: "The impugned regulatory order is quashed for want of a fair hearing.",
  keyFacts: [
    "The petitioner was not given notice before the blacklisting order was passed.",
    "The order affected the petitioner's eligibility for future government contracts.",
  ],
  issues: [
    { question: "Whether the order violated principles of natural justice.", holding: "Yes, an opportunity of hearing was mandatory." },
  ],
  courtsReasoning: "The Court reasoned that blacklisting carries civil consequences and therefore natural justice applies.",
  citedCases: {
    followed: ["Maneka Gandhi vs Union of India"],
    distinguished: [],
    overruled: [],
    referred: ["A.K. Kraipak vs Union of India"],
  },
  practiceAreas: ["Constitutional Law", "Administrative Law"],
  subCategories: ["Blacklisting", "Government Contracts"],
  tags: ["natural justice", "government contracts", "article 14"],
  procedureType: "Civil Appeal",
  precedentValue: "Binding",
  legalPrinciples: ["Audi alteram partem applies to administrative action with civil consequences."],
  doctrinesApplied: ["Audi alteram partem"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res, status, body, extraHeaders) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...(extraHeaders || {}) });
  res.end(text);
}

function bareText(res, status, text, extraHeaders) {
  res.writeHead(status, { "Content-Type": "application/json", ...(extraHeaders || {}) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

function presentedKey(req) {
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.length > 0) return apiKeyHeader;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) {
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (token.length > 0) return token;
  }
  return undefined;
}

function redactedHeaders(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === "x-api-key") { out[k] = "[REDACTED]"; continue; }
    if (k === "authorization") { out[k] = "Bearer [REDACTED]"; continue; }
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response builders (match the real API's response envelopes and field names
// exactly, per the OpenAPI spec extracted into test/e2e/openapi.json)
// ---------------------------------------------------------------------------

function unauthorized(res) {
  bareText(res, 401, JSON.stringify({ error: "Invalid API key" }));
}

function caseNotFound(res) {
  json(res, 404, { success: false, error: "Case not found" });
}

function scenario402Body() {
  return {
    success: false,
    error: "Insufficient API credits",
    code: "INSUFFICIENT_API_CREDITS",
    message: "This call needs 100 credits and the wallet has 42.",
    required: 100,
    balance: 42,
    shortfall: 58,
    wallet: "api_credits",
    walletOwner: "user",
    topUpUrl: "https://research.courtmesh.ai/api/settings/api-keys#credits",
  };
}

function scenario403TierBody() {
  return {
    success: false,
    code: "API_TIER_NOT_ALLOWED",
    message: "AI analysis is not available on the Free tier. Upgrade to generate or read case analyses.",
    tier: "free",
    upgradeUrl: "https://research.courtmesh.ai/api/settings/api-keys#credits",
  };
}

function scenario403EnterpriseBody() {
  return {
    success: false,
    code: "API_ENTERPRISE_ONLY",
    message: "The public API is available to Enterprise accounts only while self serve tiers are off.",
    tier: "payg",
    upgradeUrl: "https://research.courtmesh.ai/api/settings/api-keys#credits",
  };
}

function scenario403PartyLimitBody() {
  return {
    error: "Monthly party screen limit reached",
    code: "PARTY_SCREEN_LIMIT_REACHED",
    callsToday: 10,
    maxAllowed: 10,
  };
}

function scenario429Body() {
  return {
    success: false,
    error: "Rate limit exceeded",
    code: "RATE_LIMITED",
    message: "Too many requests. This endpoint allows 10 requests per minute.",
    retryAfter: 37,
    resetTime: new Date(Date.now() + 37_000).toISOString(),
  };
}

function scenario429DistinctBody() {
  return {
    success: false,
    error: "Rate limit exceeded",
    code: "DISTINCT_NAMES_LIMIT_REACHED",
    message: "This tier allows 25 distinct names per day.",
    retryAfter: 41_400,
    resetTime: new Date(Date.now() + 41_400_000).toISOString(),
  };
}

function scenario400TierCapBody() {
  return {
    success: false,
    code: "PAGE_LIMIT_EXCEEDED",
    limit: 150,
    tier: "free",
  };
}

function scenario503Body() {
  return { success: false, error: "Coverage data is temporarily unavailable. Please try again shortly." };
}

function scenarioCursorInvalidBody() {
  return {
    success: false,
    code: "CURSOR_INVALID",
    message: "This pagination cursor is invalid or expired. Start the query again without a cursor.",
  };
}

function scenarioRemoteFetchNotAllowedBody() {
  return {
    success: false,
    code: "REMOTE_FETCH_NOT_ALLOWED",
    message: "This case has no document stored in S3; fetching it from an external URL requires allowRemoteFetch: true in the request body.",
    tier: "payg",
    upgradeUrl: "https://research.courtmesh.ai/api/settings/api-keys#credits",
  };
}

function scenarioLiveFetchNotAllowedBody() {
  return {
    success: false,
    code: "LIVE_FETCH_NOT_ALLOWED",
    message: "Live fetches are not available on this tier. Upgrade to fetch documents that are not already in stored data.",
    tier: "free",
    upgradeUrl: "https://research.courtmesh.ai/api/settings/api-keys#credits",
  };
}

function scenarioLiveFetchLimitBody() {
  return {
    success: false,
    error: "Rate limit exceeded",
    code: "LIVE_FETCH_LIMIT_REACHED",
    message: "This tier allows 200 per day for this limit.",
    retryAfter: 28_800,
    resetTime: new Date(Date.now() + 28_800_000).toISOString(),
  };
}

function scenarioSemanticNotAllowedBody() {
  return {
    success: false,
    code: "SEMANTIC_NOT_ALLOWED",
    message: "Semantic search is not available on this tier. Upgrade for AI powered semantic search.",
    tier: "free",
    upgradeUrl: "https://research.courtmesh.ai/api/settings/api-keys#credits",
  };
}

function scenarioTooManyKeysBody() {
  return {
    success: false,
    error: "Rate limit exceeded",
    code: "TOO_MANY_KEYS_FROM_IP",
    message: "Too many different API keys used from this address today. This limit is 5 per day.",
    retryAfter: 30_000,
    resetTime: new Date(Date.now() + 30_000_000).toISOString(),
  };
}

function scenarioDistinctCasesBody() {
  return {
    success: false,
    error: "Rate limit exceeded",
    code: "DISTINCT_CASES_LIMIT_REACHED",
    message: "This tier allows 200 per day for this limit.",
    retryAfter: 12_000,
    resetTime: new Date(Date.now() + 12_000_000).toISOString(),
  };
}

function scenario429GetRetryBody() {
  return {
    success: false,
    error: "Rate limit exceeded",
    code: "RATE_LIMITED",
    message: "Too many requests. Retry shortly.",
    retryAfter: 1,
    resetTime: new Date(Date.now() + 1_000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startMockApi() {
  const requests = [];
  const timelineJobs = new Map(); // requestId -> TimelineJobStatus-shaped object
  const pendingTimers = new Set();
  // Keyed by the presented API key: how many requests scenario "429-get-retry" has seen from
  // that key so far. First request gets a RATE_LIMITED 429 with a 1 second Retry-After; every
  // request after that for the same key falls through to the normal, successful route - this is
  // what proves the real MCP client's single bounded GET retry actually works end to end.
  const rateLimitRetryCounts = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname.replace(/^\/api\/v1\/prod/, "") || "/";
    const method = req.method || "GET";
    const body = method === "POST" ? await readBody(req) : undefined;
    const key = presentedKey(req);

    requests.push({
      method,
      path: pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: redactedHeaders(req),
      hadApiKeyHeader: typeof req.headers["x-api-key"] === "string",
      hadBearerHeader: typeof req.headers.authorization === "string",
      body,
      at: Date.now(),
    });

    const headerScenario = req.headers["x-mock-scenario"];
    const scenario = (typeof headerScenario === "string" && headerScenario.length > 0)
      ? headerScenario.toLowerCase()
      : KEY_SCENARIO_MAP[key] || null;

    const noAuthRequired = pathname === "/health" || pathname === "/coverage" || pathname === "/reference/courts" || pathname === "/reference/case-types";

    // Scenario overrides apply before the normal auth/routing logic, exactly like a real
    // outage or quota gate would: they are not conditional on the request otherwise being
    // well formed.
    if (scenario === "timeout") {
      // Hangs rather than never responding at all, so a client with a long enough timeout
      // (or none) would eventually get an answer; the point is to prove the MCP server's
      // own AbortController fires before that, not to simulate a truly dead server.
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        if (!res.writableEnded) json(res, 200, { success: true, status: "healthy", version: "1.0.0", timestamp: new Date().toISOString() });
      }, 35_000);
      timer.unref();
      pendingTimers.add(timer);
      return;
    }
    if (scenario === "malformed-json") {
      bareText(res, 200, "{ this is not valid JSON, courtesy of the malformed-json mock scenario ");
      return;
    }
    if (scenario === "402") { json(res, 402, scenario402Body()); return; }
    if (scenario === "403-tier") { json(res, 403, scenario403TierBody()); return; }
    if (scenario === "403-enterprise") { json(res, 403, scenario403EnterpriseBody()); return; }
    if (scenario === "403-partylimit") { json(res, 403, scenario403PartyLimitBody()); return; }
    if (scenario === "429") { json(res, 429, scenario429Body(), { "Retry-After": "37" }); return; }
    if (scenario === "429-distinct") { json(res, 429, scenario429DistinctBody(), { "Retry-After": "41400" }); return; }
    if (scenario === "400-tiercap") { json(res, 400, scenario400TierCapBody()); return; }
    if (scenario === "503") { json(res, 503, scenario503Body()); return; }
    if (scenario === "401") { unauthorized(res); return; }
    if (scenario === "cursor-invalid") { json(res, 400, scenarioCursorInvalidBody()); return; }
    if (scenario === "remote-fetch-not-allowed") { json(res, 403, scenarioRemoteFetchNotAllowedBody()); return; }
    if (scenario === "live-fetch-not-allowed") { json(res, 403, scenarioLiveFetchNotAllowedBody()); return; }
    if (scenario === "live-fetch-limit") { json(res, 429, scenarioLiveFetchLimitBody(), { "Retry-After": "28800" }); return; }
    if (scenario === "semantic-not-allowed") { json(res, 403, scenarioSemanticNotAllowedBody()); return; }
    if (scenario === "too-many-keys") { json(res, 429, scenarioTooManyKeysBody(), { "Retry-After": "30000" }); return; }
    if (scenario === "distinct-cases-limit") { json(res, 429, scenarioDistinctCasesBody(), { "Retry-After": "12000" }); return; }
    if (scenario === "429-get-retry") {
      const seenBefore = rateLimitRetryCounts.get(key) || 0;
      rateLimitRetryCounts.set(key, seenBefore + 1);
      if (seenBefore === 0) {
        json(res, 429, scenario429GetRetryBody(), { "Retry-After": "1" });
        return;
      }
      // Second and later requests from this same key fall through to the normal route below,
      // simulating the cap having cleared by the time the client's single retry lands.
    }

    // Normal auth: /health and /coverage need no key; everything else does.
    if (!noAuthRequired) {
      if (!key || (!KNOWN_KEYS.has(key))) {
        unauthorized(res);
        return;
      }
    }

    route(pathname, method, url, body, res, { timelineJobs });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/api/v1/prod`,
    requests,
    KEYS,
    async close() {
      for (const t of pendingTimers) clearTimeout(t);
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

// ---------------------------------------------------------------------------
// Routing for the "everything is fine" path
// ---------------------------------------------------------------------------

function route(pathname, method, url, body, res, ctx) {
  // GET /health
  if (pathname === "/health" && method === "GET") {
    json(res, 200, { success: true, status: "healthy", version: "1.0.0", timestamp: new Date().toISOString() });
    return;
  }

  // GET /coverage
  if (pathname === "/coverage" && method === "GET") {
    const generatedAt = new Date().toISOString();
    json(res, 200, {
      success: true,
      data: {
        generatedAt,
        index: "courtmesh_cases",
        total: 310_452_118,
        documentBearing: 2_104_552,
        statusOnly: 308_347_566,
        byCourtType: [
          { courtType: "Supreme Court", records: 412_003, documentBearing: 398_221, latestDecisionDate: "2026-09-15" },
          { courtType: "High Court", records: 18_204_991, documentBearing: 1_204_887, latestDecisionDate: "2026-09-17" },
          { courtType: "District Court", records: 291_835_124, documentBearing: 501_444, latestDecisionDate: "2026-09-17" },
        ],
        byYear: [
          { year: 2024, records: 12_004_221 },
          { year: 2025, records: 11_887_310 },
          { year: 2026, records: 8_221_004 },
        ],
        courts: [
          { court: "Delhi High Court", records: 1_204_887, documentBearing: 302_112, earliestDecisionDate: "1950-01-05", latestDecisionDate: "2026-09-17", businessDaysBehind: 1 },
          { court: "Bombay High Court", records: 1_004_221, documentBearing: 288_004, earliestDecisionDate: "1948-03-12", latestDecisionDate: "2026-09-16", businessDaysBehind: 2 },
        ],
        districtCourts: { records: 291_835_124, documentBearing: 501_444, latestDecisionDate: "2026-09-17", businessDaysBehind: 1 },
      },
      meta: {
        generatedAt,
        cacheTtlSeconds: 21_600,
        corpusNote:
          "A record is any case CourtMesh has indexed from a court registry (parties, dates, status, docket). " +
          '"documentBearing" counts records that also have the order or judgment text indexed; the rest are ' +
          '"statusOnly", registry metadata with no document text yet. total = documentBearing + statusOnly.',
      },
    });
    return;
  }

  // GET /judges/search
  if (pathname === "/judges/search" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const all = [
      "HON'BLE MR. JUSTICE D.Y. CHANDRACHUD",
      "HON'BLE MR. JUSTICE Y.V. CHANDRACHUD",
      "HON'BLE MS. JUSTICE INDIRA BANERJEE",
      "HON'BLE MR. JUSTICE SANJIV KHANNA",
    ];
    const data = q ? all.filter((n) => n.toLowerCase().includes(q)) : all;
    json(res, 200, {
      success: true,
      data,
      meta: { query: q, responseTime: "9ms", totalMatches: data.length },
    });
    return;
  }

  // POST /search/cases
  if (pathname === "/search/cases" && method === "POST") {
    if (!body || typeof body.query !== "string" || body.query.trim().length === 0) {
      json(res, 400, {
        success: false,
        error: "Validation failed. Please check your request and try again.",
        details: ["query: Search query cannot be empty. Please provide a search term."],
      });
      return;
    }
    const hits = [CASE_PENDING, CASE_ANALYZED].map((c) => ({
      id: c.id,
      caseNumber: c.caseNumber,
      title: c.title,
      court: c.court,
      caseType: c.caseType,
      decisionDate: c.decisionDate,
      judges: c.judges,
      petitioners: c.petitioners,
      respondents: c.respondents,
      disposalNature: c.disposalNature,
      summary: c.summary,
    }));
    // A cursor in the request means this is (simulated as) the second page: end of results,
    // nextCursor null. No cursor means this is the first page: hand back an opaque signed-looking
    // string (never the legacy raw array shape) for the caller to pass back as `cursor` next time.
    const hasCursorInput = typeof body.cursor === "string" && body.cursor.length > 0;
    json(res, 200, {
      success: true,
      data: hits,
      meta: { query: body.query, filters: { court: body.court, year: body.year, caseType: body.caseType, judgeName: body.judgeName ?? body.judges ?? body.judge }, responseTime: "412ms" },
      pagination: {
        page: body.page || 1,
        limit: body.limit || 20,
        total: hits.length,
        hasMore: !hasCursorInput,
        nextCursor: hasCursorInput ? null : "eyJzYSI6WyJtb2NrIl0sImRlcHRoIjoyMCwicSI6ImFiYzEyMyJ9.mocksignature",
      },
    });
    return;
  }

  // POST /search/cases/semantic
  if (pathname === "/search/cases/semantic" && method === "POST") {
    if (!body || typeof body.query !== "string" || body.query.trim().length < 3) {
      json(res, 400, {
        success: false,
        error: "Validation failed. Please check your request and try again.",
        details: ["query: Query must be at least 3 characters."],
      });
      return;
    }
    const data = [CASE_ANALYZED, CASE_PENDING].map((c) => ({
      id: c.id,
      caseNumber: c.caseNumber,
      title: c.title,
      court: c.court,
      caseType: c.caseType,
      judges: c.judges,
      petitioners: c.petitioners,
      respondents: c.respondents,
      decisionDate: c.decisionDate,
      disposalNature: c.disposalNature,
      summary: c.summary,
      hasDocuments: c.hasDocuments,
      hasAnalysis: c.hasAnalysis,
      similarity: c === CASE_ANALYZED ? 0.87 : 0.61,
    }));
    json(res, 200, {
      success: true,
      data,
      meta: {
        query: body.query,
        appliedFilters: body.filters || {},
        responseTime: "8412ms",
        searchType: "semantic",
      },
      pagination: { page: body.page || 1, limit: body.limit || 20, total: data.length, totalPages: 1, hasMore: false },
    });
    return;
  }

  // /cases/{id}...
  const caseMatch = pathname.match(/^\/cases\/([^/]+)(\/(analysis|related|pdf|analyze|analyze-consolidated))?$/);
  if (caseMatch) {
    const id = decodeURIComponent(caseMatch[1]);
    const sub = caseMatch[3];
    const record = id === CASE_PENDING.id ? CASE_PENDING : id === CASE_ANALYZED.id ? CASE_ANALYZED : id === CASE_NO_DOCS.id ? CASE_NO_DOCS : null;

    if (!sub && method === "GET") {
      if (!record) { caseNotFound(res); return; }
      const { hasDocuments, documentCount, hasAnalysis, ...rest } = record;
      json(res, 200, {
        success: true,
        data: { ...rest, hasDocuments, documentCount, hasAnalysis },
        meta: { responseTime: "31ms", note: "Use /cases/:id/analysis endpoint to get AI analysis separately" },
      });
      return;
    }

    if (sub === "analysis" && method === "GET") {
      if (!record) { caseNotFound(res); return; }
      if (!record.hasAnalysis) {
        json(res, 200, {
          success: true,
          data: { id: record.id, caseNumber: record.caseNumber, hasAnalysis: false, message: "AI analysis not available for this case" },
          meta: { responseTime: "18ms", note: "Use POST /cases/:id/analyze to generate AI analysis" },
        });
        return;
      }
      json(res, 200, {
        success: true,
        data: { id: record.id, caseNumber: record.caseNumber, hasAnalysis: true, analysis: ANALYSIS_BODY },
        meta: { responseTime: "27ms", note: "" },
      });
      return;
    }

    if (sub === "related" && method === "GET") {
      if (!record) { caseNotFound(res); return; }
      const other = record === CASE_PENDING ? CASE_ANALYZED : CASE_PENDING;
      const relatedDocuments = [
        { id: record.id, title: record.title, caseNumber: record.caseNumber, court: record.court, decisionDate: record.decisionDate, caseType: record.caseType, isCurrent: true },
      ];
      const timeline = [
        { date: record.decisionDate, status: "Final Judgment", statusLabel: record.disposalNature, documentId: record.id },
      ];
      json(res, 200, {
        success: true,
        data: { relatedDocuments, timeline },
        meta: { responseTime: "44ms", caseNumber: record.caseNumber, totalDocuments: relatedDocuments.length, timelineEvents: timeline.length },
      });
      return;
    }

    if (sub === "pdf" && method === "GET") {
      // Two distinct 404s, matching api-v1-prod.ts: CASE_NOT_FOUND (no such case at all) versus
      // PDF_NOT_STORED (the case exists but has no stored document), the latter with a hint.
      if (!record) { json(res, 404, { success: false, error: "Case not found", code: "CASE_NOT_FOUND" }); return; }
      if (!record.hasDocuments) {
        json(res, 404, {
          success: false,
          error: "PDF not available for this case",
          code: "PDF_NOT_STORED",
          hint: "no stored document for this case; POST /request-timeline with refresh:true may fetch orders for High Court and District Court cases; tribunal documents are not fetchable via the API",
        });
        return;
      }
      json(res, 200, {
        success: true,
        data: {
          pdfUrl: `enc:${Buffer.from(`${record.id}:mock-presigned`).toString("base64")}`,
          expiresIn: 3600,
          caseId: record.id,
          caseNumber: record.caseNumber,
          caseTitle: record.title,
        },
        meta: { responseTime: "96ms", note: "The PDF URL is encrypted and expires in 1 hour. Use the decryption key provided in your SDK." },
      });
      return;
    }

    if (sub === "analyze" && method === "POST") {
      if (!record) { caseNotFound(res); return; }
      const force = body && body.force === true;
      if (record.hasAnalysis && !force) {
        json(res, 200, {
          success: true,
          data: { message: "Analysis already exists", analysis: ANALYSIS_BODY, alreadyExists: true },
          meta: { responseTime: "22ms" },
        });
        return;
      }
      json(res, 202, {
        success: true,
        data: { message: "Analysis has been started", status: "processing" },
        meta: { responseTime: "18ms", note: "You can check the analysis status by calling the GET /cases/:id endpoint in 30-60 seconds." },
      });
      return;
    }

    if (sub === "analyze-consolidated" && method === "POST") {
      if (!record) { caseNotFound(res); return; }
      const force = body && body.force === true;
      const key = `consolidated:${record.id}`;
      const already = ctx.timelineJobs.get(key);
      if (already && !force) {
        json(res, 200, {
          success: true,
          data: { status: "already_analyzed", consolidatedAnalysis: ANALYSIS_BODY, message: "Consolidated analysis already exists for this matter." },
          meta: { responseTime: "12ms" },
        });
        return;
      }
      ctx.timelineJobs.set(key, true);
      json(res, 200, {
        success: true,
        data: { status: "success", consolidatedAnalysis: ANALYSIS_BODY, message: "Consolidated analysis complete." },
        meta: { responseTime: "48211ms", relatedCases: 3 },
      });
      return;
    }
  }

  // POST /request-timeline
  if (pathname === "/request-timeline" && method === "POST") {
    const caseId = body && body.case_id;
    if (!caseId || !/^[0-9a-fA-F]{24}$/.test(caseId)) {
      json(res, 400, { success: false, error: "case_id must be a 24 character hexadecimal case id" });
      return;
    }
    const record = caseId === CASE_PENDING.id ? CASE_PENDING : caseId === CASE_ANALYZED.id ? CASE_ANALYZED : null;
    if (!record) { caseNotFound(res); return; }

    const requestId = randomUUID();
    const now = new Date().toISOString();
    // Pre-complete the job so GET /get-timeline/{requestId} can be polled immediately in
    // tests without a real wait, while the POST response still reports "pending" the way
    // a High Court case realistically would.
    ctx.timelineJobs.set(requestId, {
      requestId,
      status: "completed",
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
      orders: [
        { orderDate: "2026-08-01", orderType: "Hearing", description: "Matter listed for arguments.", documentId: record.id },
      ],
      orderCount: 1,
      totalOrderCount: 1,
    });
    const liveFetch = body.refresh === true;
    json(res, 200, {
      success: true,
      data: { requestId, status: "pending" },
      meta: { responseTime: "212ms", liveFetch },
    });
    return;
  }

  // GET /get-timeline/{requestId}
  const timelineMatch = pathname.match(/^\/get-timeline\/([^/]+)$/);
  if (timelineMatch && method === "GET") {
    const requestId = decodeURIComponent(timelineMatch[1]);
    const job = ctx.timelineJobs.get(requestId);
    if (!job || typeof job !== "object" || !("status" in job)) {
      json(res, 404, { success: false, error: "Request not found" });
      return;
    }
    json(res, 200, { success: true, data: job, meta: { responseTime: "6ms" } });
    return;
  }

  // POST /party/screen
  if (pathname === "/party/screen" && method === "POST") {
    if (!body || typeof body.name !== "string" || body.name.trim().length < 2 || !body.entityType || !body.purpose) {
      json(res, 400, {
        success: false,
        error: "Validation failed. Please check your request and try again.",
        details: ["name: Name must be at least 2 characters.", "purpose: Required."],
      });
      return;
    }
    const adjudicate = body.adjudicate === true;
    const limit = typeof body.limit === "number" ? body.limit : 40;
    const displayThreshold = typeof body.displayThreshold === "number" ? body.displayThreshold : 0.6;

    const band = body.entityType === "person" ? "probable" : "confirmed";
    const match = {
      caseId: CASE_PENDING.id,
      title: CASE_PENDING.title,
      court: CASE_PENDING.court,
      caseNumber: CASE_PENDING.caseNumber,
      caseType: CASE_PENDING.caseType,
      petitioners: CASE_PENDING.petitioners,
      respondents: CASE_PENDING.respondents,
      decisionDate: CASE_PENDING.decisionDate,
      disposalNature: CASE_PENDING.disposalNature,
      summary: CASE_PENDING.summary,
      casePageUrl: `https://research.courtmesh.ai/case/${CASE_PENDING.id}`,
      partyRole: "respondent",
      confidence: {
        band,
        score: band === "confirmed" ? 0.93 : 0.74,
        calibrated: band === "confirmed" ? 0.93 : 0.74,
        engine: adjudicate ? "llm" : "rules",
      },
      evidence: {
        entityMatch: true,
        matchedFields: body.identifiers && Object.keys(body.identifiers).length > 0 ? ["name", "identifier"] : ["name"],
        strategies: ["exact_name", "fuzzy_name"],
        signals: [{ name: "name_similarity", status: "matched", weight: "strong", evidence: body.name }],
        nameSimilarity: 0.92,
        disambiguatorPresent: Boolean(body.identifiers || body.address || body.knownPersons),
      },
      rationale: "Name and party role align closely with the searched party.",
    };
    const matches = [match];
    const relatedButUnverified = [
      {
        caseId: CASE_ANALYZED.id,
        title: CASE_ANALYZED.title,
        court: CASE_ANALYZED.court,
        caseNumber: CASE_ANALYZED.caseNumber,
        casePageUrl: `https://research.courtmesh.ai/case/${CASE_ANALYZED.id}`,
      },
    ];
    const baseCredits = matches.length > 0 ? 100 : 20;
    const creditsCharged = baseCredits + (adjudicate ? 80 : 0);
    const corpusAsOf = new Date().toISOString();

    json(res, 200, {
      success: true,
      data: {
        query: {
          name: body.name,
          aliases: body.aliases || [],
          entityType: body.entityType,
          purpose: body.purpose,
          court: body.court,
          since: body.since,
          limit,
          adjudicate,
          displayThreshold,
        },
        summary: {
          matchCount: matches.length,
          byBand: { confirmed: band === "confirmed" ? 1 : 0, probable: band === "probable" ? 1 : 0, possible: 0, unlikely: 0 },
          highestBand: matches.length > 0 ? band : null,
          verdict: matches.length > 0 ? "matches_found" : "no_matches_found",
        },
        matches,
        relatedButUnverified,
        coverage: {
          exhaustive: true,
          exhaustiveWithinFilters: true,
          planClamped: false,
          anyStrategyErrored: false,
          strategiesRun: ["exact_name", "fuzzy_name", "identifier_lookup"],
          someRecordsWithheld: false,
        },
        adjudicationsRun: adjudicate ? matches.length : 0,
        notice:
          "This is a records search, not a legal or compliance opinion. A party may request removal of their " +
          "own record under CourtMesh's case removal policy; see casePageUrl for the public case page.",
      },
      meta: { creditsCharged, adjudicated: adjudicate, corpusAsOf, responseTime: "1840ms" },
    });
    return;
  }

  // GET /usage
  if (pathname === "/usage" && method === "GET") {
    json(res, 200, {
      success: true,
      data: {
        tier: "payg",
        walletOwner: { type: "user", id: "mock-user-1" },
        balance: { total: 4820, monthlyGrant: 0, signupGrant: 1000, purchased: 4000 },
        limits: {
          requestsPerMinute: 60,
          requestsPerDay: 5000,
          requestsPerMonth: 100_000,
          maxPageSize: 50,
          maxPaginationDepth: 500,
          distinctCaseFetchesPerDay: 200,
          pdfCallsPerMonth: 200,
          aiCallsPerMonth: 100,
          concurrentAnalyzeJobs: 2,
          apiKeys: 5,
          semanticSearchAllowed: true,
          liveFetchAllowed: true,
          liveFetchesPerDay: 20,
          analysisReadAllowed: true,
          partyScreensPerMonth: 100,
        },
        period: { start: "2026-09-01T00:00:00.000+05:30", end: "2026-09-30T23:59:59.999+05:30", key: "2026-09" },
        creditsUsedThisPeriod: 340,
        byEndpoint: [
          { endpoint: "/api/v1/prod/search/cases", calls: 12, credits: 12 },
          { endpoint: "/api/v1/prod/party/screen", calls: 2, credits: 220 },
        ],
        subscriptionRenewsAt: null,
      },
      meta: { requestId: randomUUID() },
    });
    return;
  }

  // GET /reference/courts
  if (pathname === "/reference/courts" && method === "GET") {
    json(res, 200, {
      success: true,
      data: {
        courtTypes: ["Supreme Court", "High Court", "District Court", "Tribunal"],
        courtsByType: {
          "Supreme Court": ["Supreme Court of India"],
          "High Court": ["Delhi High Court", "Bombay High Court"],
          "District Court": ["District Court"],
          Tribunal: ["National Company Law Tribunal"],
        },
        courtNamesByCourt: {
          "Supreme Court of India": ["Supreme Court of India"],
          "Delhi High Court": ["High Court of Delhi"],
          "Bombay High Court": ["High Court of Judicature at Bombay"],
        },
      },
    });
    return;
  }

  // GET /reference/case-types
  if (pathname === "/reference/case-types" && method === "GET") {
    json(res, 200, {
      success: true,
      data: [
        { code: "CRL.A.", fullForm: "Criminal Appeal", primaryType: "Criminal", nature: "Appellate" },
        { code: "WP(C)", fullForm: "Writ Petition (Civil)", primaryType: "Civil", nature: "Original" },
      ],
    });
    return;
  }

  // POST /party/screen/batch
  if (pathname === "/party/screen/batch" && method === "POST") {
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0 || items.length > 25 || !body?.purpose) {
      json(res, 400, {
        success: false,
        error: "Validation failed. Please check your request and try again.",
        details: ["items: Must contain between 1 and 25 items.", "purpose: Required."],
      });
      return;
    }
    let matchesFound = 0;
    let noMatches = 0;
    let errors = 0;
    const results = items.map((item, index) => {
      // "FORCE_ERROR" is a mock-only marker (not a real API rule) simulating one item
      // independently failing without failing the rest of the batch. A real per item
      // failure would be, for example, a name that fails the server's own 2..200
      // character validation - not reproducible here since the MCP tool's own zod
      // schema already enforces that length client side before a request is ever sent.
      if (typeof item?.name !== "string" || item.name.trim().length < 2 || item.name === "FORCE_ERROR") {
        errors += 1;
        return {
          clientRef: item?.clientRef,
          index,
          ok: false,
          error: { code: "VALIDATION_ERROR", message: "name must be 2..200 characters" },
        };
      }
      const entityType = item.entityType || body.entityType || "person";
      const band = entityType === "person" ? "probable" : "confirmed";
      const found = index % 2 === 0;
      if (found) matchesFound += 1;
      else noMatches += 1;
      return {
        clientRef: item.clientRef,
        index,
        ok: true,
        screen: {
          query: { name: item.name, aliases: item.aliases || [], entityType, purpose: body.purpose, limit: item.limit || 40, displayThreshold: item.displayThreshold ?? 0.6 },
          summary: {
            matchCount: found ? 1 : 0,
            byBand: { confirmed: found && band === "confirmed" ? 1 : 0, probable: found && band === "probable" ? 1 : 0, possible: 0, unlikely: 0 },
            highestBand: found ? band : null,
            verdict: found ? "matches_found" : "no_matches_found",
          },
          matches: found
            ? [
                {
                  caseId: CASE_PENDING.id,
                  title: CASE_PENDING.title,
                  court: CASE_PENDING.court,
                  caseNumber: CASE_PENDING.caseNumber,
                  partyRole: "respondent",
                  confidence: { band, score: 0.9, calibrated: 0.9, engine: "rules" },
                  evidence: { entityMatch: true, matchedFields: ["name"], strategies: ["exact_name"], signals: [], nameSimilarity: 0.9, disambiguatorPresent: false },
                  casePageUrl: `https://research.courtmesh.ai/case/${CASE_PENDING.id}`,
                },
              ]
            : [],
          relatedButUnverified: [],
          coverage: {
            exhaustive: true,
            exhaustiveWithinFilters: true,
            planClamped: false,
            anyStrategyErrored: false,
            strategiesRun: ["exact_name", "fuzzy_name"],
            someRecordsWithheld: false,
          },
          adjudicationsRun: 0,
          notice: "This is a records search, not a legal or compliance opinion.",
        },
      };
    });
    const creditsCharged = results.reduce((sum, r) => sum + (r.ok ? (r.screen.summary.matchCount > 0 ? 100 : 20) : 0), 0);
    json(res, 200, {
      success: true,
      data: {
        results,
        summary: { items: items.length, matchesFound, noMatches, inconclusive: 0, errors },
      },
      meta: { creditsCharged, requestId: randomUUID() },
    });
    return;
  }

  json(res, 404, { error: "Not found (mock has no route for this path)." });
}

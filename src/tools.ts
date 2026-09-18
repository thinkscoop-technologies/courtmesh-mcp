/**
 * Tool definitions and handlers for the CourtMesh MCP server.
 *
 * Each tool wraps one CourtMesh REST endpoint. Handlers never throw: every
 * failure path (network error, timeout, HTTP error status, or the
 * success:false in body quirk on /search/cases/semantic) is converted into
 * an MCP tool result with isError: true and a readable text message, so the
 * calling model can recover instead of the whole turn failing.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CourtMeshApiError, DEFAULT_TIMEOUT_MS, LONG_TIMEOUT_MS, TIMELINE_TIMEOUT_MS, request } from "./client.js";
import { getApiKeyOverride } from "./context.js";

export interface ToolServerOptions {
  baseUrl: string;
  apiKey: string | undefined;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function textResult(payload: unknown, note?: string): CallToolResult {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  const text = note ? `${note}\n\n${body}` : body;
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function paginationNote(pagination: any): string | undefined {
  if (!pagination || typeof pagination !== "object") return undefined;
  const parts: string[] = [];
  if (pagination.page !== undefined) parts.push(`page ${pagination.page}`);
  if (pagination.totalPages !== undefined) parts.push(`of ${pagination.totalPages} pages`);
  if (pagination.total !== undefined) parts.push(`${pagination.total} total results`);
  if (pagination.hasMore) parts.push("more results are available");
  // nextCursor is null, not merely absent, when there is no further page - this used to check
  // only !== undefined, so a null cursor was advertised to the calling model as something to
  // pass back on the next call. Its shape also depends on the server's self serve tiers flag:
  // an opaque signed string (pass back as `cursor`) when the flag is on, or the legacy raw
  // OpenSearch sort tuple array (pass back as `searchAfter`) when it is off. Either way, this
  // note just surfaces the value; the tool description tells the caller which field to use.
  if (pagination.nextCursor !== undefined && pagination.nextCursor !== null) {
    parts.push(`next page cursor, pass back as cursor (or searchAfter if it is an array): ${JSON.stringify(pagination.nextCursor)}`);
  }
  return parts.length > 0 ? `Pagination: ${parts.join(", ")}.` : undefined;
}

/**
 * Runs one CourtMesh API call and returns either the parsed envelope or a
 * ready to display error string. Never throws.
 */
async function callApi(
  opts: ToolServerOptions,
  reqOpts: {
    method?: "GET" | "POST";
    path: string;
    query?: Record<string, any>;
    body?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
  }
): Promise<{ ok: true; data: any } | { ok: false; message: string }> {
  try {
    const data = await request({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      apiKeyOverride: getApiKeyOverride(),
      ...reqOpts,
    });
    return { ok: true, data };
  } catch (err) {
    if (err instanceof CourtMeshApiError) {
      return { ok: false, message: err.message };
    }
    return {
      ok: false,
      message: `Unexpected error calling the CourtMesh API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The line every idempotency-key tool result starts with when the response was served from the
 * server's 24 hour idempotency cache rather than freshly computed (client.ts sets `replayed` on
 * the parsed body from the `Idempotency-Replayed` response header). Without this, the only way to
 * notice a replay was to spot that screen_party_litigation's query.name/aliases had been swapped
 * for redaction placeholders - no positive "this was a replay, you were not charged" signal
 * existed anywhere in the tool output.
 */
const REPLAYED_NOTE =
  "Replayed: identical request served from the 24 hour idempotency cache, no credits charged.";

/** Wraps an envelope response {data, meta, pagination} into a tool result. */
function envelopeResult(body: any, extraNote?: string): CallToolResult {
  const out: Record<string, unknown> = {};
  if (body?.data !== undefined) out.data = body.data;
  if (body?.meta !== undefined) out.meta = body.meta;
  if (body?.pagination !== undefined) out.pagination = body.pagination;
  const notes = [extraNote, paginationNote(body?.pagination)].filter((n): n is string => Boolean(n));
  return textResult(Object.keys(out).length > 0 ? out : body, notes.length > 0 ? notes.join("\n") : undefined);
}

/** True when client.ts marked this parsed response body as a replay of an idempotency-cached call. */
function isReplayed(body: any): boolean {
  return Boolean(body && typeof body === "object" && body.replayed === true);
}

/**
 * search_indian_court_cases's underlying OpenSearch index currently returns `mongoId` on each hit
 * but not `id`, even though every tool description here (get_case, find_related_cases,
 * get_case_pdf_url, and especially request_case_timeline's case_id) tells the calling model to
 * pass "the id field from search results". The server is expected to add `id` additively at some
 * point; until (and even after) it does, fill it in here from `mongoId` so the documented
 * instruction is actually true against this endpoint's real output. Mutates each hit in place;
 * mongoId is left untouched alongside the new id.
 */
function backfillSearchHitIds(body: any): void {
  const hits = body?.data;
  if (!Array.isArray(hits)) return;
  for (const hit of hits) {
    if (hit && typeof hit === "object" && hit.id === undefined && typeof hit.mongoId === "string") {
      hit.id = hit.mongoId;
    }
  }
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively so
 * two calls with the same arguments in a different key order hash to the
 * same string. Used only by computeIdempotencyKey below.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/**
 * Derives a stable `Idempotency-Key` from a tool name plus its arguments, so
 * a model that retries the exact same tool call (its own retry logic, a
 * dropped connection, a re-sent turn) never double-charges or double-runs a
 * job: the second call is recognised server side as a replay of the first
 * and returns the stored response instead of doing the work again. A call
 * with even one different argument value hashes to a different key and runs
 * as a brand new request, as it should.
 *
 * SHA-256 hex digest: exactly the `[A-Za-z0-9_.-]` charset the server's
 * `Idempotency-Key` header requires, 64 characters, well under its 128
 * character cap.
 */
export function computeIdempotencyKey(toolName: string, args: unknown): string {
  return createHash("sha256").update(`${toolName}:${stableStringify(args ?? {})}`).digest("hex");
}

const idParam = z
  .string()
  .min(1)
  .describe(
    "Case identifier: either a 24 character MongoDB ObjectId hex string, or a case number string. " +
      "Lookup order: the server first tries to parse this as an ObjectId; only if that parse fails does it fall " +
      "back to looking up by case number. This means a syntactically valid but nonexistent ObjectId returns 404 " +
      "without ever trying the case number path."
  );

const stringOrArray = (description: string) =>
  z.union([z.string(), z.array(z.string())]).optional().describe(description);

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerCourtMeshTools(server: McpServer, opts: ToolServerOptions): void {
  // 1. search_indian_court_cases -----------------------------------------
  const yearValue = z.union([z.number().int(), z.string().regex(/^\d{4}$/, "must be a 4 digit year string")]);

  server.registerTool(
    "search_indian_court_cases",
    {
      title: "Search Indian Court Cases",
      description:
        "Keyword and boolean search over the full 310M plus record OpenSearch index of Indian court cases. " +
        "Fast, exact match, does not consume AI credits. Prefer this over semantic_search_cases for case numbers, " +
        "party names, citations, judge names and exact phrases. Use semantic_search_cases instead when the request " +
        "is a natural language question about legal concepts, doctrines or fact patterns rather than exact terms. " +
        "Note: caseNumber does filter results (a single value; if an array is sent only the first element is " +
        "used). Note: sortBy is honoured: relevance, recent and oldest are all real sort orders. date is accepted " +
        "as a deprecated alias for recent, and the response's meta carries a notice explaining the substitution; " +
        "prefer sending recent or oldest directly. Each result carries an id field to pass to get_case, " +
        "get_case_analysis, find_related_cases, get_case_pdf_url and request_case_timeline; on hits where the " +
        "index only supplies mongoId, this tool copies mongoId into id for you, so id is always present here " +
        "even if you also see a raw mongoId alongside it.",
      inputSchema: {
        query: z.string().trim().min(1).describe("Search text: keywords, a phrase, a case number, or a party name."),
        court: stringOrArray("Court name or list of court names to filter by."),
        year: z
          .union([yearValue, z.array(yearValue)])
          .optional()
          .describe("Year or list of years, each 1947 to the current year, as an integer or a 4 digit string."),
        caseType: stringOrArray("Case type or list of case types to filter by."),
        caseNumber: stringOrArray(
          "Case number to filter by. The server filters on a single case number string; if a list is passed here, " +
            "only the first element is actually used. The applied value is echoed back in the response meta.filters."
        ),
        judgeName: stringOrArray(
          "Judge name or list of judge names to filter by. Aliases judges and judge are also accepted; if more " +
            "than one of judgeName, judges, judge is supplied only the first set one is used, in that order. " +
            "Use search_judges first to get the exact spelling."
        ),
        judges: stringOrArray("Alias for judgeName, see judgeName."),
        judge: stringOrArray("Alias for judgeName, see judgeName."),
        fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").optional().describe("Start date, inclusive, YYYY-MM-DD."),
        toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").optional().describe("End date, inclusive, YYYY-MM-DD."),
        page: z.number().int().min(1).optional().describe("Page number, default 1."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "Results per page, 1 to 100, default 20. Each tier caps this lower: the Free tier's page size cap is " +
              "20. Sending a limit above the caller's tier cap is rejected with HTTP 400 PAGE_LIMIT_EXCEEDED, and " +
              "a page times limit depth beyond the tier's pagination depth cap is rejected with HTTP 400 " +
              "PAGINATION_DEPTH_EXCEEDED; both responses carry the tier and the limit actually allowed."
          ),
        sortBy: z
          .enum(["relevance", "recent", "oldest", "date"])
          .optional()
          .describe(
            "Sort order, default relevance. relevance, recent and oldest are all honoured by the search engine. " +
              "date is accepted too, as a deprecated alias that is applied as recent; prefer recent or oldest."
          ),
        cursor: z
          .string()
          .trim()
          .optional()
          .describe(
            "Opaque signed pagination cursor. Pass back the pagination.nextCursor string from a previous " +
              "response, unmodified, to fetch the next page; it is bound to the exact query and filters it was " +
              "issued for, so changing any of those and reusing an old cursor, or hand editing it, fails with HTTP " +
              "400 CURSOR_INVALID, at which point start the search again without a cursor. Prefer this over page " +
              "for paging beyond the first few thousand results. This is the current mechanism; searchAfter below " +
              "is the older one, honoured only while the server's self serve API tiers feature is off."
          ),
        searchAfter: z
          .string()
          .optional()
          .describe(
            "Legacy deep pagination cursor, honoured only while the server's self serve API tiers feature is off " +
              "(prefer cursor above otherwise, which replaces this). Pass back the JSON encoded " +
              "pagination.nextCursor array from a previous response."
          ),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { query, court, year, caseType, caseNumber, judgeName, judges, judge, fromDate, toDate, page, limit, sortBy, cursor, searchAfter } =
        args as any;
      const body: Record<string, unknown> = { query };
      if (court !== undefined) body.court = court;
      if (year !== undefined) body.year = year;
      if (caseType !== undefined) body.caseType = caseType;
      if (caseNumber !== undefined) body.caseNumber = caseNumber;
      const judgeValue = judgeName ?? judges ?? judge;
      if (judgeValue !== undefined) body.judgeName = judgeValue;
      if (fromDate !== undefined) body.fromDate = fromDate;
      if (toDate !== undefined) body.toDate = toDate;
      if (page !== undefined) body.page = page;
      if (limit !== undefined) body.limit = limit;
      if (sortBy !== undefined) body.sortBy = sortBy;
      if (cursor !== undefined) body.cursor = cursor;
      if (searchAfter !== undefined) body.searchAfter = searchAfter;

      const result = await callApi(opts, { method: "POST", path: "search/cases", body, timeoutMs: DEFAULT_TIMEOUT_MS });
      if (!result.ok) return errorResult(result.message);
      backfillSearchHitIds(result.data);
      return envelopeResult(result.data);
    }
  );

  // 2. semantic_search_cases ----------------------------------------------
  const semanticJudgeParam = z
    .union([
      z.string().trim().min(1),
      z.array(z.string().trim().min(1)).max(1, "only one judge name is honoured per semantic search request"),
    ])
    .optional()
    .describe(
      "Judge name to filter by: a single value, or a one element array of the same. The vector index matches " +
        "one judge name per request; a second value is rejected with a 400. Aliases judges and judge are also " +
        "accepted, in that order of precedence. Use search_indian_court_cases for more than one judge, or to " +
        "get the exact spelling via search_judges first."
    );

  server.registerTool(
    "semantic_search_cases",
    {
      title: "Semantic Search Cases",
      description:
        "AI vector search over the roughly 2M case subset that has embeddings, out of the full 310M plus corpus. " +
        "CONSUMES AI CREDITS. Prefer this over search_indian_court_cases for natural language questions about " +
        "legal concepts, fact patterns or doctrines, where exact keywords will not match. Slower, a single call " +
        "can take a minute or more. Top level court, year, caseType, judgeName (and aliases judges, judge), " +
        "caseNumber, fromDate and toDate are all real filters here: each is mapped onto the vector store's own " +
        "filter keys and echoed back in meta.appliedFilters, alongside whatever the service auto extracted from " +
        "the query text. The nested filters object below addresses the vector store's own keys directly (court, " +
        "caseType, caseYear, judgeName, caseNumber, decisionDate.$gte/$lte) and takes precedence over the top " +
        "level fields and over auto extraction when the same key is set in more than one place. caseNumber here " +
        "must be digits only (the vector index filters case numbers numerically); use search_indian_court_cases " +
        "for a formatted case number string. Free tier note: this endpoint returns HTTP 403 SEMANTIC_NOT_ALLOWED " +
        "on the Free tier, which has no semantic search access at all, only keyword search via " +
        "search_indian_court_cases. Another quirk: if the cleaned query text ends up shorter than 3 characters " +
        "after internal processing, the service falls back to a plain keyword search and marks the response " +
        "with meta.fallbackMode = \"opensearch\".",
      inputSchema: {
        query: z.string().trim().min(3).describe("Natural language question or description, minimum 3 characters."),
        court: stringOrArray("Court name or list of court names to filter by."),
        year: z
          .union([yearValue, z.array(yearValue)])
          .optional()
          .describe("Year or list of years, each 1947 to the current year, as an integer or a 4 digit string."),
        caseType: stringOrArray("Case type or list of case types to filter by."),
        caseNumber: z
          .union([
            z.string().trim().regex(/^\d+$/, 'must be digits only, e.g. "1234"'),
            z.array(z.string().trim().regex(/^\d+$/, 'must be digits only, e.g. "1234"')),
          ])
          .optional()
          .describe(
            "Case number filter, digits only (e.g. \"1234\"), because the vector index filters case numbers " +
              "numerically and cannot match a formatted string like \"WP(C) 123/2024\". Use search_indian_court_cases " +
              "to filter on a full formatted case number."
          ),
        judgeName: semanticJudgeParam,
        judges: semanticJudgeParam,
        judge: semanticJudgeParam,
        fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").optional().describe("Start date, inclusive, YYYY-MM-DD."),
        toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").optional().describe("End date, inclusive, YYYY-MM-DD."),
        page: z.number().int().min(1).optional().describe("Page number, default 1."),
        limit: z.number().int().min(1).max(100).optional().describe("Results per page, 1 to 100, default 20, clamped to 100 server side."),
        filters: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Free form filter object passed straight through to the vector store, addressing its own keys " +
              "directly: court, caseType, caseYear, judgeName, caseNumber, and decisionDate as an object with " +
              "$gte and or $lte sub keys for range filtering. Takes precedence over the top level court/year/" +
              "caseType/judgeName/caseNumber/fromDate/toDate fields above and over auto extraction from the " +
              "query text when the same key is set in more than one place."
          ),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { query, court, year, caseType, caseNumber, judgeName, judges, judge, fromDate, toDate, page, limit, filters } = args as any;
      const body: Record<string, unknown> = { query };
      if (court !== undefined) body.court = court;
      if (year !== undefined) body.year = year;
      if (caseType !== undefined) body.caseType = caseType;
      if (caseNumber !== undefined) body.caseNumber = caseNumber;
      const judgeValue = judgeName ?? judges ?? judge;
      if (judgeValue !== undefined) body.judgeName = judgeValue;
      if (fromDate !== undefined) body.fromDate = fromDate;
      if (toDate !== undefined) body.toDate = toDate;
      if (page !== undefined) body.page = page;
      if (limit !== undefined) body.limit = limit;
      if (filters !== undefined) body.filters = filters;

      const result = await callApi(opts, {
        method: "POST",
        path: "search/cases/semantic",
        body,
        timeoutMs: LONG_TIMEOUT_MS,
      });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 3. get_case -------------------------------------------------------------
  server.registerTool(
    "get_case",
    {
      title: "Get Case",
      description:
        "Fetches full details for one case, without AI analysis. No AI credits consumed. Returns id, caseNumber, " +
        "title, court, caseType, judges, petitioners, respondents, decisionDate, disposalNature, summary, " +
        "optional metadata.diaryNumber, hasDocuments, documentCount and hasAnalysis. Fields like " +
        "detailedSummary, headnote, holding and keyFacts are NOT included here, call get_case_analysis " +
        "for those.",
      inputSchema: { id: idParam },
    },
    async (args): Promise<CallToolResult> => {
      const { id } = args as any;
      const result = await callApi(opts, { method: "GET", path: `cases/${encodeURIComponent(id)}` });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 4. get_case_analysis ----------------------------------------------------
  server.registerTool(
    "get_case_analysis",
    {
      title: "Get Case Analysis",
      description:
        "Reads any existing AI analysis for a case. Read only: does NOT trigger new analysis and does NOT consume " +
        "AI credits. If analysis has not been generated yet, hasAnalysis will be false and you will get a message " +
        "field instead of an analysis field; in that case call analyze_case to generate it. When hasAnalysis is " +
        "true, analysis may include summary, detailedSummary, comprehensiveSummary, headnote, holding, keyFacts, " +
        "issues, courtsReasoning, citedCases (followed, distinguished, overruled, referred), " +
        "precedentRelationships, arguments (petitioner, respondent), practiceAreas, subCategories, tags, " +
        "procedureType, precedentValue, legalPrinciples, doctrinesApplied, statutoryInterpretation and " +
        "constitutionalProvisions. Fields with no value are omitted from the response. Free tier note: this read " +
        "returns HTTP 403 API_TIER_NOT_ALLOWED with an upgrade URL on the free tier, same as analyze_case; the " +
        "free tier has no access to AI analysis in any form.",
      inputSchema: { id: idParam },
    },
    async (args): Promise<CallToolResult> => {
      const { id } = args as any;
      const result = await callApi(opts, { method: "GET", path: `cases/${encodeURIComponent(id)}/analysis` });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 5. find_related_cases -----------------------------------------------
  server.registerTool(
    "find_related_cases",
    {
      title: "Find Related Cases",
      description:
        "Finds other documents sharing the same case number as the given case, plus a derived procedural " +
        "timeline. No AI credits consumed. This is NOT similarity search, it only follows the shared case number; " +
        "for conceptually similar cases use semantic_search_cases instead. Returns relatedDocuments (each with " +
        "id, title, caseNumber, court, decisionDate, caseType, isCurrent), capped at 50, and timeline entries " +
        "(date, status, statusLabel, documentId), where status is one of Case Initiated, Hearings / Orders, or " +
        "Final Judgment. Only documents that have both a decision date and a stored PDF appear in the timeline. " +
        "meta carries caseNumber, totalDocuments and timelineEvents.",
      inputSchema: { id: idParam },
    },
    async (args): Promise<CallToolResult> => {
      const { id } = args as any;
      const result = await callApi(opts, { method: "GET", path: `cases/${encodeURIComponent(id)}/related` });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 6. search_judges ---------------------------------------------------------
  server.registerTool(
    "search_judges",
    {
      title: "Search Judges",
      description:
        "Autocomplete over the combined Supreme Court and High Court judge name list. No AI credits consumed. " +
        "Use this to get the exact spelling of a judge name before passing it to search_indian_court_cases as " +
        "judgeName. Matching is case insensitive substring matching. An empty or omitted q returns the first 50 " +
        "names in the list. Results are always capped at 50.",
      inputSchema: {
        q: z.string().optional().describe("Search term to match against judge names, case insensitive substring match."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { q } = args as any;
      const result = await callApi(opts, { method: "GET", path: "judges/search", query: { q } });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 7. analyze_case -----------------------------------------------------
  server.registerTool(
    "analyze_case",
    {
      title: "Analyze Case",
      description:
        "Triggers AI analysis of a single case. CONSUMES 100 AI CREDITS per call, plus a further 20 credit " +
        "surcharge when the source document has to be fetched from a remote court host rather than served from " +
        "stored data (see allowRemoteFetch). ASYNCHRONOUS: normally returns immediately with status processing " +
        "while the analysis runs in the background; poll get_case_analysis after roughly 30 to 60 seconds to " +
        "retrieve the result. If analysis already exists and force is not set, the existing analysis is returned " +
        "immediately instead with alreadyExists true, at no extra charge. Set force true to re-analyze a case " +
        "that already has analysis, which also consumes credits again. Fails with a clear message if the case " +
        "has no usable text or PDF content to analyze. Free tier note: this tool, analyze_consolidated_case, and " +
        "reading analysis on the free tier all return HTTP 403 API_TIER_NOT_ALLOWED with an upgrade URL; the " +
        "free tier gets no AI analysis at all, only keyword search, case detail, related cases, judges, PDF, " +
        "semantic search and a limited party/screen allowance. This call sends an Idempotency-Key derived from " +
        "the exact id/force/allowRemoteFetch arguments, so retrying this same call (a dropped connection, a " +
        "re-sent turn) never re-triggers analysis or re-charges credits; changing any argument runs as a new call. " +
        "When a replay happens, the result text starts with a \"Replayed: ...\" line so you can tell it apart from " +
        "a freshly computed result.",
      inputSchema: {
        id: idParam,
        force: z.boolean().optional().describe("Re-run analysis even if it already exists, default false."),
        allowRemoteFetch: z
          .boolean()
          .optional()
          .describe(
            "Set true to allow fetching the case's source document from a remote court host (only ecourts.gov.in, " +
              "nic.in, sci.gov.in, gov.in and courtmesh.ai hosts are ever eligible) when it is not already " +
              "available as stored text or an S3 document. Default false. Without it, a case that needs a remote " +
              "fetch to be analyzed returns HTTP 403 REMOTE_FETCH_NOT_ALLOWED instead of running (this is a " +
              "one time consent per call, not a standing setting); when it is used and a remote fetch actually " +
              "happens, a 20 credit surcharge is added on top of the base analyze price. Not available on the " +
              "Free tier, which returns 403 REMOTE_FETCH_NOT_ALLOWED regardless of this flag."
          ),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { id, force, allowRemoteFetch } = args as any;
      const body: Record<string, unknown> = {};
      if (force !== undefined) body.force = force;
      if (allowRemoteFetch !== undefined) body.allowRemoteFetch = allowRemoteFetch;
      const result = await callApi(opts, {
        method: "POST",
        path: `cases/${encodeURIComponent(id)}/analyze`,
        body,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        idempotencyKey: computeIdempotencyKey("analyze_case", args),
      });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data, isReplayed(result.data) ? REPLAYED_NOTE : undefined);
    }
  );

  // 8. analyze_consolidated_case ----------------------------------------
  server.registerTool(
    "analyze_consolidated_case",
    {
      title: "Analyze Consolidated Case",
      description:
        "Runs AI analysis across ALL documents that share the given case number, producing one merged view of the " +
        "whole matter. CONSUMES SIGNIFICANTLY MORE AI CREDITS than analyze_case. SYNCHRONOUS: this call blocks " +
        "until the analysis completes, which can take several minutes, so a long timeout is used. For a High " +
        "Court case it analyzes the case document plus up to 5 most recent orders. For a Supreme Court case it " +
        "analyzes up to 20 documents sharing the case number. Set force true to redo analysis that already " +
        "exists, at the cost of credits again. Fails if the case has no case number or no text content, or if AI " +
        "credits are exhausted. Free tier note: this tool returns HTTP 403 API_TIER_NOT_ALLOWED with an upgrade " +
        "URL on the free tier, same as analyze_case; the free tier has no access to AI analysis in any form. " +
        "This call sends an Idempotency-Key derived from the exact id/force arguments, so retrying this same " +
        "call never re-runs the consolidated analysis or re-charges credits; changing any argument runs as a new " +
        "call. When a replay happens, the result text starts with a \"Replayed: ...\" line so you can tell it " +
        "apart from a freshly computed result.",
      inputSchema: {
        id: idParam,
        force: z.boolean().optional().describe("Re-run consolidated analysis even if it already exists, default false."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { id, force } = args as any;
      const body: Record<string, unknown> = {};
      if (force !== undefined) body.force = force;
      const result = await callApi(opts, {
        method: "POST",
        path: `cases/${encodeURIComponent(id)}/analyze-consolidated`,
        body,
        timeoutMs: LONG_TIMEOUT_MS,
        idempotencyKey: computeIdempotencyKey("analyze_consolidated_case", args),
      });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data, isReplayed(result.data) ? REPLAYED_NOTE : undefined);
    }
  );

  // 9. get_case_pdf_url ---------------------------------------------------
  server.registerTool(
    "get_case_pdf_url",
    {
      title: "Get Case PDF URL",
      description:
        "Returns a time limited link to the official judgment PDF for a case. No AI credits consumed. CRITICAL: " +
        "the returned pdfUrl is an ENCRYPTED presigned S3 URL, not a directly fetchable link, it must be " +
        "decrypted with a case specific key before use, and it expires after the returned expiresIn seconds " +
        "(normally 3600). Do not attempt to fetch pdfUrl directly, treat it as an opaque token to hand back to " +
        "the user or to a CourtMesh client that knows how to decrypt it. Two distinct 404s: code CASE_NOT_FOUND " +
        "means no case matches the given id at all; code PDF_NOT_STORED means the case exists but has no stored " +
        "document, and comes with a hint field suggesting request_case_timeline with refresh:true, which can " +
        "fetch orders for High Court and District Court cases (tribunal documents are not fetchable via this API).",
      inputSchema: { id: idParam },
    },
    async (args): Promise<CallToolResult> => {
      const { id } = args as any;
      const result = await callApi(opts, { method: "GET", path: `cases/${encodeURIComponent(id)}/pdf` });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 10. request_case_timeline -------------------------------------------
  server.registerTool(
    "request_case_timeline",
    {
      title: "Request Case Timeline",
      description:
        "Reads or refreshes the order and hearing history for a case. No AI credits consumed. case_id must be " +
        "the 24 character MongoDB ObjectId string, the id field from search results, a case number will fail. " +
        "By default (refresh omitted or false) this is a STORED read: 1 credit, meta.liveFetch is false, and it " +
        "never contacts a court portal. Set refresh true to force a LIVE fetch directly from the court's own " +
        "systems instead: 20 credits, meta.liveFetch true, available on PAYG and above only (Free tier returns " +
        "HTTP 403 LIVE_FETCH_NOT_ALLOWED), and subject to a per tier daily cap (HTTP 429 " +
        "LIVE_FETCH_LIMIT_REACHED once exhausted, with a Retry-After telling you when it resets). Supreme Court " +
        "cases return immediately with status completed and orderCount 0, since SC cases have no separate order " +
        "history in this system. District Court cases are fetched synchronously and come back completed or " +
        "failed. High Court cases usually return pending and must be polled with get_case_timeline using the " +
        "returned requestId. A live refresh can take a while against a slow court portal, so this call uses a " +
        "longer timeout than most tools. This call sends an Idempotency-Key derived from the exact " +
        "case_id/refresh arguments, so retrying this same call never re-triggers a live fetch or re-charges " +
        "credits; changing any argument runs as a new call. When a replay happens, the result text starts with a " +
        "\"Replayed: ...\" line so you can tell it apart from a freshly computed result.",
      inputSchema: {
        case_id: z
          .string()
          .min(1)
          .describe("24 character MongoDB ObjectId string for the case, from the id field of a search result. A case number will not work here."),
        refresh: z
          .boolean()
          .optional()
          .describe(
            "Default false: a stored-only read, 1 credit, meta.liveFetch false, never touches a court portal. " +
              "Set true to force a live fetch from the court's own systems: 20 credits, meta.liveFetch true, " +
              "PAYG tier or above only (403 LIVE_FETCH_NOT_ALLOWED on Free), and capped per day per tier (429 " +
              "LIVE_FETCH_LIMIT_REACHED once exhausted)."
          ),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { case_id, refresh } = args as any;
      const body: Record<string, unknown> = { case_id };
      if (refresh !== undefined) body.refresh = refresh;
      const result = await callApi(opts, {
        method: "POST",
        path: "request-timeline",
        body,
        timeoutMs: TIMELINE_TIMEOUT_MS,
        idempotencyKey: computeIdempotencyKey("request_case_timeline", args),
      });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data, isReplayed(result.data) ? REPLAYED_NOTE : undefined);
    }
  );

  // 11. get_case_timeline -------------------------------------------------
  server.registerTool(
    "get_case_timeline",
    {
      title: "Get Case Timeline",
      description:
        "Polls the status and result of a job started by request_case_timeline. No AI credits consumed. Returns " +
        "requestId, status, createdAt, updatedAt plus, when available, startedAt, completedAt, error, result, " +
        "orders, orderCount and totalOrderCount. Returns 404 if the request is not found, which can mean the " +
        "requestId is wrong or has expired.",
      inputSchema: {
        requestId: z.string().min(1).describe("The requestId returned by request_case_timeline."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { requestId } = args as any;
      const result = await callApi(opts, { method: "GET", path: `get-timeline/${encodeURIComponent(requestId)}` });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 12. check_api_health ---------------------------------------------------
  server.registerTool(
    "check_api_health",
    {
      title: "Check API Health",
      description:
        "Checks whether the CourtMesh API is reachable and healthy. No authentication required and no AI credits " +
        "consumed. Useful to verify connectivity, and to confirm that connectivity problems are not caused by API " +
        "key configuration, since this endpoint works even without a key. Returns success, status, version and " +
        "timestamp; note this endpoint does not use the standard data envelope used by every other tool here.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const result = await callApi(opts, { method: "GET", path: "health" });
      if (!result.ok) return errorResult(result.message);
      return textResult(result.data);
    }
  );

  // 13. screen_party_litigation ---------------------------------------------
  server.registerTool(
    "screen_party_litigation",
    {
      title: "Screen Party Litigation",
      description:
        "Litigation check for one person or company name against the full case corpus: KYC, background " +
        "verification, due diligence, counterparty and litigation screening. CONSUMES AI CREDITS: 100 credits if " +
        "the screen finds any matches, 20 credits if it finds none, plus a further 80 credit surcharge if " +
        "adjudicate is set true. purpose is REQUIRED and is not decorative: it is recorded under DPDP as the " +
        "lawful basis for processing this name, so pick the value that actually describes why this screen is " +
        "being run (kyc, bgv, due_diligence, litigation, research, compliance), never a placeholder. " +
        "IMPORTANT ABOUT WHAT A MATCH MEANS: a match is a case record whose party text matches the given name and " +
        "identifiers to some confidence band, it is NOT a verified statement that this specific real world person " +
        "or company is a litigant. Common names, aliases and identical entity names across different individuals " +
        "or companies all produce matches; always read confidence.band, evidence.matchedFields and " +
        "evidence.disambiguatorPresent before treating a match as identity-confirmed, and prefer matches with an " +
        "identifier (PAN, GSTIN, CIN, LLPIN) or address corroboration over name-only matches, especially for " +
        "common person names. summary.verdict is one of matches_found, no_matches_found or inconclusive, and its " +
        "rules are stricter than they look: no_matches_found is only ever returned when coverage.exhaustive is " +
        "true (every available search strategy actually ran to completion) AND nothing was withheld; sending " +
        "since always forces inconclusive too, because it is a best effort post filter that cannot certify " +
        "completeness in either direction; and a withheld record (a restricted case, an unverifiable id, a masked " +
        "title) with no other surviving match also forces inconclusive rather than a clean negative. Conversely, " +
        "summary.matchCount (the size of the displayed matches array) can read 0 while verdict still reads " +
        "matches_found, when every internally matching candidate was filtered out of the display by " +
        "displayThreshold - verdict describes what was found, matchCount/matches describe what is shown at your " +
        "threshold, and only the former should be treated as authoritative for \"was anything found\". Report an " +
        "inconclusive or partial screen as exactly that, never as a clean record. The response's top level notice " +
        "field (not coverage.note, which does not exist) carries the case removal / right-to-be-forgotten policy " +
        "text; always surface it plus coverage.someRecordsWithheld to the end user rather than silently treating " +
        "an inconclusive or partial screen as a clearance. adjudicate (default false) turns on an LLM " +
        "disambiguation pass over the uncertain middle of the candidates for a more confident band; identifiers " +
        "are never sent to the adjudication model. The +80 credit surcharge for adjudicate is charged only when " +
        "adjudicationsRun is actually greater than 0 in the response - every candidate can already have been " +
        "decisive (an exact identifier match, or too dissimilar to bother), in which case no model call happens " +
        "and no surcharge is billed even though adjudicate was true. Free tier: 10 screens per month, and " +
        "adjudicate:true is a HARD BLOCK there, not a silent ignore - it returns HTTP 403 API_TIER_NOT_ALLOWED " +
        "before any screening runs at all, so do not set adjudicate true for a Free tier caller. The Free tier " +
        "also has no semantic_search_cases access (403 SEMANTIC_NOT_ALLOWED) and no live court/timeline fetches " +
        "(request_case_timeline's refresh:true needs PAYG or above), so a Free tier litigation check is keyword " +
        "search plus deterministic party screening only. This is a records search, not a legal or compliance " +
        "opinion; casePageUrl in each match links to the public case page. This call sends an Idempotency-Key " +
        "derived from every argument here, so retrying this exact same screen never re-charges credits; changing " +
        "any argument (including name, aliases or identifiers) runs as a new, separately charged screen. When a " +
        "replay happens, the result text starts with a \"Replayed: ...\" line so you can tell it apart from a " +
        "freshly computed result (in addition to query.name/query.aliases coming back redacted, same as any " +
        "stored record). Use screen_party_litigation_batch instead to screen more than one name in a single call.",
      inputSchema: {
        name: z
          .string()
          .trim()
          .min(2)
          .max(200)
          .describe("Full name to screen: a person's name or a company/entity name, 2 to 200 characters."),
        aliases: z
          .array(z.string().trim().min(1))
          .max(7)
          .optional()
          .describe("Up to 7 alternate spellings or former names for the same person or entity, screened alongside name."),
        entityType: z
          .enum(["person", "company"])
          .describe("Whether name refers to an individual (person) or an organization (company)."),
        purpose: z
          .enum(["kyc", "bgv", "due_diligence", "litigation", "research", "compliance"])
          .describe(
            "REQUIRED. The DPDP lawful basis for this screen: kyc (know your customer), bgv (background " +
              "verification, typically employment), due_diligence (commercial/transaction diligence), litigation " +
              "(active or prospective dispute), research (non-decisional legal research), or compliance " +
              "(regulatory/AML/sanctions style checks). This is recorded against the request, so choose the value " +
              "that genuinely describes why the name is being screened."
          ),
        identifiers: z
          .object({
            pan: z.string().trim().optional().describe("Income tax PAN, for a person or company."),
            gstin: z.string().trim().optional().describe("GST identification number, for a company."),
            cin: z.string().trim().optional().describe("Corporate Identification Number, for a company."),
            llpin: z.string().trim().optional().describe("LLP Identification Number, for an LLP."),
          })
          .optional()
          .describe(
            "Government identifiers, when known. Strongly recommended for company/entity screens and for common " +
              "person names: an identifier match is much stronger evidence than a name-only match and materially " +
              "improves confidence banding. Never sent to the adjudication model even when adjudicate is true."
          ),
        address: z
          .object({
            city: z.string().trim().optional(),
            state: z.string().trim().optional(),
            stateCode: z.string().trim().optional().describe("State code, for example MH, DL, KA."),
          })
          .optional()
          .describe("Known address details, used as a disambiguating signal alongside name and identifiers."),
        knownPersons: z
          .array(z.string().trim().min(1))
          .max(10, "knownPersons can hold at most 10 entries")
          .optional()
          .describe(
            "Names of directors, partners, family members or known associates, used to help disambiguate between " +
              "same-named parties in different case records. Up to 10 entries."
          ),
        court: z
          .union([z.string().trim(), z.array(z.string().trim()).max(1, "one court per request for now")])
          .optional()
          .describe(
            "Restrict the screen to a single court: a court name string, or a one element array of the same. " +
              "Only one court is ever honoured; a multi element array is rejected with a 400 rather than silently " +
              "narrowed to its first entry."
          ),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
          .optional()
          .describe(
            "Only consider cases filed or decided on or after this date, YYYY-MM-DD. This is a best effort post " +
              "filter, not a guarantee of completeness in either direction, so using it at all forces " +
              "summary.verdict to inconclusive - see the tool description."
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100, "limit cannot exceed 100")
          .optional()
          .describe("Maximum number of matches to return, 1 to 100, default 40."),
        adjudicate: z
          .boolean()
          .optional()
          .describe(
            "Run an LLM adjudication pass over the uncertain middle of the candidates for sharper confidence " +
              "banding. Default false. A +80 credit surcharge applies, but only when the response's " +
              "adjudicationsRun is actually greater than 0 (some candidates may already be decisive and need no " +
              "model call). NOT AVAILABLE on the Free tier: setting this true there is a hard block, HTTP 403 " +
              "API_TIER_NOT_ALLOWED, before any screening runs, not a silent no-op."
          ),
        displayThreshold: z
          .number()
          .min(0, "displayThreshold must be between 0 and 1")
          .max(1, "displayThreshold must be between 0 and 1")
          .optional()
          .describe(
            "Minimum confidence score, 0 to 1, for a candidate to be included in the displayed matches array. A " +
              "Confirmed band candidate is always shown regardless of this value. Candidates this excludes are " +
              "simply left out of matches, not moved into relatedButUnverified (which is a separate, unrelated set " +
              "of same-case-number documents the search engine could not itself verify as a match at all). Raising " +
              "this can make matches empty (matchCount 0) even though summary.verdict still reads matches_found - " +
              "see the tool description. Omit to use the service default (0.6)."
          ),
      },
    },
    async (args): Promise<CallToolResult> => {
      const {
        name,
        aliases,
        entityType,
        purpose,
        identifiers,
        address,
        knownPersons,
        court,
        since,
        limit,
        adjudicate,
        displayThreshold,
      } = args as any;
      const body: Record<string, unknown> = { name, entityType, purpose };
      if (aliases !== undefined) body.aliases = aliases;
      if (identifiers !== undefined) body.identifiers = identifiers;
      if (address !== undefined) body.address = address;
      if (knownPersons !== undefined) body.knownPersons = knownPersons;
      if (court !== undefined) body.court = court;
      if (since !== undefined) body.since = since;
      if (limit !== undefined) body.limit = limit;
      if (adjudicate !== undefined) body.adjudicate = adjudicate;
      if (displayThreshold !== undefined) body.displayThreshold = displayThreshold;

      const result = await callApi(opts, {
        method: "POST",
        path: "party/screen",
        body,
        timeoutMs: LONG_TIMEOUT_MS,
        idempotencyKey: computeIdempotencyKey("screen_party_litigation", args),
      });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data, isReplayed(result.data) ? REPLAYED_NOTE : undefined);
    }
  );

  // 14. get_court_coverage ---------------------------------------------------
  server.registerTool(
    "get_court_coverage",
    {
      title: "Get Court Coverage",
      description:
        "Reads the current corpus coverage and freshness snapshot: total records, the document-bearing versus " +
        "status-only split, a breakdown by court type and by year, per-court figures, and a rolled up District " +
        "Court row. No authentication required and no AI credits consumed. The response is cached for several " +
        "hours server side (see meta.cacheTtlSeconds), so treat generatedAt as the figure's as-of time rather than " +
        "expecting a live count on every call. Useful before or alongside screen_party_litigation to explain what " +
        "a no_matches_found or inconclusive verdict is measured against, and to answer general questions about how " +
        "much of the Indian court system this API actually covers.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const result = await callApi(opts, { method: "GET", path: "coverage" });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 15. get_api_usage ---------------------------------------------------------
  server.registerTool(
    "get_api_usage",
    {
      title: "Get API Usage",
      description:
        "Reports this API key's tier, wallet balance, per period limits and per endpoint call volume for the " +
        "current Asia/Kolkata calendar month. UNMETERED: checking your own usage never itself consumes a credit. " +
        "Returns tier, walletOwner (type: user or org, id), balance (total, monthlyGrant, signupGrant, purchased), " +
        "limits (the full per tier limits object: requestsPerMinute, requestsPerDay, requestsPerMonth, " +
        "maxPageSize, maxPaginationDepth, distinctCaseFetchesPerDay, pdfCallsPerMonth, aiCallsPerMonth, " +
        "concurrentAnalyzeJobs, apiKeys, semanticSearchAllowed, liveFetchAllowed, liveFetchesPerDay, " +
        "analysisReadAllowed, partyScreensPerMonth), period (start, end, key for the current billing month), " +
        "creditsUsedThisPeriod, byEndpoint (calls and credits per endpoint) and subscriptionRenewsAt. Useful " +
        "before a credit heavy call (analyze_case, analyze_consolidated_case, semantic_search_cases, " +
        "screen_party_litigation) to check remaining balance and tier limits first.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const result = await callApi(opts, { method: "GET", path: "usage" });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 16. list_reference_courts --------------------------------------------------
  server.registerTool(
    "list_reference_courts",
    {
      title: "List Reference Courts",
      description:
        "Reads the court taxonomy accepted by the court filter on search_indian_court_cases, semantic_search_cases " +
        "and screen_party_litigation: the 4 court types (courtTypes), the court values under each type " +
        "(courtsByType, with High Court collapsed to representative labels), and the display name(s) per court " +
        "(courtNamesByCourt). No authentication or API key required, no AI credits consumed. Cached for 1 hour " +
        "server side. Use this to get an exact, valid court value before filtering a search or a litigation " +
        "screen by court, rather than guessing a spelling.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const result = await callApi(opts, { method: "GET", path: "reference/courts" });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 17. list_reference_case_types -----------------------------------------------
  server.registerTool(
    "list_reference_case_types",
    {
      title: "List Reference Case Types",
      description:
        "Reads every caseType value accepted by the caseType filter on search_indian_court_cases and " +
        "semantic_search_cases: a flat, deduplicated (by code) and sorted list, each entry carrying code, " +
        "fullForm, primaryType and nature. No authentication or API key required, no AI credits consumed. Cached " +
        "for 1 hour server side, same as list_reference_courts. Use this to get an exact, valid caseType value " +
        "before filtering a search by case type, rather than guessing an abbreviation.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const result = await callApi(opts, { method: "GET", path: "reference/case-types" });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 18. screen_party_litigation_batch --------------------------------------------
  server.registerTool(
    "screen_party_litigation_batch",
    {
      title: "Screen Party Litigation (Batch)",
      description:
        "Screens up to 25 person or company names against the case corpus in a single call: the same litigation, " +
        "insolvency and related court record check as screen_party_litigation, run once per item. Each item is " +
        "independently priced (100 credits if it finds matches, 20 if it finds none) and can independently fail " +
        "(check ok on each entry of the returned results array; a failed item carries error.code/error.message " +
        "and does not fail the rest of the batch). NOT AVAILABLE on the Free tier. LLM adjudication is NOT " +
        "supported in this batch form (there is no per item or batch level adjudicate option here); call " +
        "screen_party_litigation directly, one name at a time, when adjudication is needed. " +
        "DPDP note, same as screen_party_litigation: purpose is REQUIRED at the batch level and is recorded as " +
        "the lawful basis for processing every name in this batch, so pick the value that actually describes why " +
        "this batch is being run (kyc, bgv, due_diligence, litigation, research, compliance), never a placeholder. " +
        "IMPORTANT ABOUT WHAT A MATCH MEANS: exactly as in screen_party_litigation, a match is a case record whose " +
        "party text matches the given name and identifiers to some confidence band, not a verified statement " +
        "about a specific real world person or company; read each item's confidence.band and evidence before " +
        "treating a match as identity confirmed. Each item's own screen object has the same summary.verdict rules " +
        "(matches_found, no_matches_found, inconclusive) and the same notice/coverage.someRecordsWithheld fields " +
        "as screen_party_litigation - always surface those per item rather than summarizing the whole batch as a " +
        "single clean or dirty result. This call sends an Idempotency-Key derived from every argument here, so " +
        "retrying this exact same batch never re-charges credits; changing any item runs as a new, separately " +
        "charged batch. When a replay happens, the result text starts with a \"Replayed: ...\" line so you can " +
        "tell it apart from a freshly computed result.",
      inputSchema: {
        items: z
          .array(
            z.object({
              clientRef: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe(
                  "Optional caller supplied label for this item, echoed back verbatim on the matching result " +
                    "entry (alongside its index) so you can line results up with requests. Not sent to, or used " +
                    "by, the screening logic itself."
                ),
              name: z
                .string()
                .trim()
                .min(2)
                .max(200)
                .describe("Full name to screen: a person's name or a company/entity name, 2 to 200 characters."),
              aliases: z
                .array(z.string().trim().min(1))
                .max(7)
                .optional()
                .describe("Up to 7 alternate spellings or former names for the same person or entity."),
              entityType: z
                .enum(["person", "company"])
                .optional()
                .describe(
                  "Whether name refers to an individual (person) or an organization (company). Falls back to " +
                    "this call's own top level entityType when omitted on an item."
                ),
              identifiers: z
                .object({
                  pan: z.string().trim().optional(),
                  gstin: z.string().trim().optional(),
                  cin: z.string().trim().optional(),
                  llpin: z.string().trim().optional(),
                })
                .optional()
                .describe("Government identifiers, when known. See screen_party_litigation for details."),
              address: z
                .object({
                  city: z.string().trim().optional(),
                  state: z.string().trim().optional(),
                  stateCode: z.string().trim().optional(),
                })
                .optional(),
              knownPersons: z.array(z.string().trim().min(1)).max(10).optional(),
              court: z
                .union([z.string().trim(), z.array(z.string().trim()).max(1, "one court per item for now")])
                .optional(),
              since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").optional(),
              limit: z.number().int().min(1).max(100).optional(),
              displayThreshold: z.number().min(0).max(1).optional(),
            })
          )
          .min(1)
          .max(25, "at most 25 items per batch")
          .describe("1 to 25 items, each shaped like screen_party_litigation's own arguments (minus purpose/adjudicate, which are batch level here)."),
        purpose: z
          .enum(["kyc", "bgv", "due_diligence", "litigation", "research", "compliance"])
          .describe(
            "REQUIRED. The DPDP lawful basis for every screen in this batch. See screen_party_litigation for what " +
              "each value means."
          ),
        entityType: z
          .enum(["person", "company"])
          .optional()
          .describe("Default entityType applied to any item above that does not specify its own."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { items, purpose, entityType } = args as any;
      const body: Record<string, unknown> = { items, purpose };
      if (entityType !== undefined) body.entityType = entityType;

      const result = await callApi(opts, {
        method: "POST",
        path: "party/screen/batch",
        body,
        timeoutMs: LONG_TIMEOUT_MS,
        idempotencyKey: computeIdempotencyKey("screen_party_litigation_batch", args),
      });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data, isReplayed(result.data) ? REPLAYED_NOTE : undefined);
    }
  );

  // ---------------------------------------------------------------------------
  // Deliberately NOT implemented here: watchlist and webhook tools.
  //
  // The backend plan (Phase M2) adds POST/GET/DELETE watchlist endpoints and
  // webhook subscription management on top of party/screen. Both are stateful
  // (they create and own server side resources tied to the caller's account)
  // and billable (watchlist events and webhook deliveries carry their own
  // credit cost once shipped). An MCP tool call is a one-shot, fire-and-forget
  // action with no confirmation step and no per-call cost visible to the
  // calling model ahead of time, which is the wrong shape for "create a
  // standing subscription that keeps charging me" or "register a URL that
  // will receive my data going forward". Add these only once M2 ships, and
  // only with an explicit confirmation/cost-preview step, not as a plain
  // registerTool alongside the read-only and single-shot tools above.
  // ---------------------------------------------------------------------------
}

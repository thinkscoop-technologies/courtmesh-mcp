/**
 * Tool definitions and handlers for the CourtMesh MCP server.
 *
 * Each tool wraps one CourtMesh REST endpoint. Handlers never throw: every
 * failure path (network error, timeout, HTTP error status, or the
 * success:false in body quirk on /search/cases/semantic) is converted into
 * an MCP tool result with isError: true and a readable text message, so the
 * calling model can recover instead of the whole turn failing.
 */

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CourtMeshApiError, DEFAULT_TIMEOUT_MS, LONG_TIMEOUT_MS, LOOKUP_TIMEOUT_MS, TIMELINE_TIMEOUT_MS, request } from "./client.js";
import { getApiKeyOverride } from "./context.js";
import { cnrForRequest, normalizeCnr } from "./cnr.js";
import {
  CHECK_MAX_DAYS,
  COURT_KEY_PATTERN,
  LISTINGS_MAX_DAYS,
  MATTER_ID_PATTERN,
  MAX_RESULT_CHARS,
  PROVENANCE_NOTE,
  UNTRUSTED_META,
  CHECK_REPLAY_BUCKET_MS,
  compactCheckData,
  defaultCheckRange,
  describeRemaining,
  cnrDatesProblem,
  dateRangeProblems,
  isIsoDate,
} from "./cause-lists.js";

export interface ToolServerOptions {
  baseUrl: string;
  apiKey: string | undefined;
  /**
   * Mixed into every Idempotency-Key this server computes (see
   * computeIdempotencyKey), so a replay only ever happens within the caller's
   * own session: over stdio this is a random value generated once per
   * process, and over Streamable HTTP it is the Mcp-Session-Id assigned when
   * that session was initialized (see createServer in src/index.ts). Before
   * this existed the key was derived from the tool name and arguments alone,
   * so two unrelated callers who happened to send byte identical arguments
   * within the same 24 hour window would silently replay each other's cached
   * result, with no signal beyond the "Replayed:" note that this had even
   * happened.
   */
  sessionSalt: string;
  /** Clock in milliseconds since the epoch. Tests only; defaults to Date.now. */
  now?: () => number;
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
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    query?: Record<string, any>;
    body?: unknown;
    timeoutMs?: number;
    idempotencyKey?: string;
    signal?: AbortSignal;
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
 * `sessionSalt` (see ToolServerOptions) is mixed in so the key space is
 * scoped to one session: identical arguments sent from two different
 * sessions (two separate MCP clients, or two separate stdio processes) hash
 * to two different keys and never replay one another, even inside the
 * server's 24 hour idempotency window. Retries *within* one session still
 * replay, which is the point.
 *
 * `nonce`, when supplied (see the `fresh` argument on the five POST-backed
 * tools), is mixed in too so the caller can deliberately force a fresh key
 * for otherwise identical arguments in the same session, bypassing the
 * replay cache for that one call. Omit it for the normal, replay-eligible
 * key.
 *
 * SHA-256 hex digest: exactly the `[A-Za-z0-9_.-]` charset the server's
 * `Idempotency-Key` header requires, 64 characters, well under its 128
 * character cap.
 */
export function computeIdempotencyKey(
  toolName: string,
  args: unknown,
  sessionSalt: string,
  nonce?: string
): string {
  const noncePart = nonce !== undefined ? `:fresh:${nonce}` : "";
  return createHash("sha256")
    .update(`${sessionSalt}:${toolName}:${stableStringify(args ?? {})}${noncePart}`)
    .digest("hex");
}

/** Optional boolean schema shared by the five POST-backed tools' `fresh` argument. */
const freshParam = z
  .boolean()
  .optional()
  .describe(
    "Default false. A repeat call with otherwise identical arguments in this same session replays the cached " +
      "result within 24 hours and is not charged again (see the Idempotency-Key note below). Set fresh true to " +
      "bypass that and force a genuine re-run: this mixes a random nonce into the Idempotency-Key so the call is " +
      "always treated as new, even if every other argument is unchanged, and is charged accordingly. This flag " +
      "itself is never sent to the CourtMesh API."
  );

const idParam = z
  .string()
  .min(1)
  .describe(
    "Case identifier: either a 24 character hexadecimal case id, or a case number string. " +
      "Lookup order: the server first tries this as a case id; only if that fails does it fall " +
      "back to looking up by case number. This means a syntactically valid but nonexistent case id returns 404 " +
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
        "Keyword and boolean search over our full 310M plus record search index of Indian court cases. " +
        "Fast, exact match, does not consume AI credits. Prefer this over semantic_search_cases for case numbers, " +
        "party names, citations, judge names and exact phrases. Use semantic_search_cases instead when the request " +
        "is a natural language question about legal concepts, doctrines or fact patterns rather than exact terms. " +
        "Note: caseNumber does filter results (a single value; if an array is sent only the first element is " +
        "used). Note: sortBy is honoured: relevance, recent and oldest are all real sort orders. date is accepted " +
        "as a deprecated alias for recent, and the response's meta carries a notice explaining the substitution; " +
        "prefer sending recent or oldest directly. Each result carries an id field to pass to get_case, " +
        "get_case_analysis, find_related_cases, get_case_pdf_url and request_case_timeline; id is always " +
        "present on each result.",
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
        "with meta.fallbackMode to indicate the keyword index was used instead.",
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
      const result = await callApi(opts, { method: "GET", path: `cases/${encodeURIComponent(id)}`, timeoutMs: LOOKUP_TIMEOUT_MS });
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
        "Reads any existing AI analysis for a case. Read only: does NOT trigger new analysis. Costs 1 credit per " +
        "read, except the first time your organization reads a given case's analysis, which costs the credits " +
        "generating that analysis used (up to 400). If analysis has not been generated yet, hasAnalysis will be false and you will get a message " +
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
      const result = await callApi(opts, { method: "GET", path: `cases/${encodeURIComponent(id)}/analysis`, timeoutMs: LOOKUP_TIMEOUT_MS });
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
      const result = await callApi(opts, { method: "GET", path: `cases/${encodeURIComponent(id)}/related`, timeoutMs: LOOKUP_TIMEOUT_MS });
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
        "immediately instead with alreadyExists true, priced as a read of it rather than a new analysis: 1 credit, or " +
        "the generation credits the first time your organization reads that case. Set force true to re-analyze a case " +
        "that already has analysis, which also consumes credits again. Fails with a clear message if the case " +
        "has no usable text or PDF content to analyze. Free tier note: this tool, analyze_consolidated_case, and " +
        "reading analysis on the free tier all return HTTP 403 API_TIER_NOT_ALLOWED with an upgrade URL; the " +
        "free tier gets no AI analysis at all, only keyword search, case detail, related cases, judges, PDF, " +
        "semantic search and a limited party/screen allowance. This call sends an Idempotency-Key derived from " +
        "the exact id/force/allowRemoteFetch arguments plus this session, so retrying this same call in this same " +
        "session (a dropped connection, a re-sent turn) never re-triggers analysis or re-charges credits; the " +
        "identical call from a different session is never treated as a replay of this one, and changing any " +
        "argument here also runs as a new call. When a replay happens, the result text starts with a " +
        "\"Replayed: ...\" line so you can tell it apart from a freshly computed result. Set fresh true to force a " +
        "re-run, see the fresh argument.",
      inputSchema: {
        id: idParam,
        force: z.boolean().optional().describe("Re-run analysis even if it already exists, default false."),
        allowRemoteFetch: z
          .boolean()
          .optional()
          .describe(
            "Set true to allow fetching the case's source document from an external source (only approved court " +
              "and official sources are ever eligible) when it is not already " +
              "available as stored text or a stored document. Default false. Without it, a case that needs a remote " +
              "fetch to be analyzed returns HTTP 403 REMOTE_FETCH_NOT_ALLOWED instead of running (this is a " +
              "one time consent per call, not a standing setting); when it is used and a remote fetch actually " +
              "happens, a 20 credit surcharge is added on top of the base analyze price. Not available on the " +
              "Free tier, which returns 403 REMOTE_FETCH_NOT_ALLOWED regardless of this flag."
          ),
        fresh: freshParam,
      },
    },
    async (args): Promise<CallToolResult> => {
      const { id, force, allowRemoteFetch, fresh } = args as any;
      const body: Record<string, unknown> = {};
      if (force !== undefined) body.force = force;
      if (allowRemoteFetch !== undefined) body.allowRemoteFetch = allowRemoteFetch;
      const result = await callApi(opts, {
        method: "POST",
        path: `cases/${encodeURIComponent(id)}/analyze`,
        body,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        idempotencyKey: computeIdempotencyKey(
          "analyze_case",
          { id, force, allowRemoteFetch },
          opts.sessionSalt,
          fresh ? randomUUID() : undefined
        ),
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
        "This call sends an Idempotency-Key derived from the exact id/force arguments plus this session, so " +
        "retrying this same call in this same session never re-runs the consolidated analysis or re-charges " +
        "credits; the identical call from a different session is never treated as a replay of this one, and " +
        "changing any argument here also runs as a new call. When a replay happens, the result text starts with a " +
        "\"Replayed: ...\" line so you can tell it apart from a freshly computed result. Set fresh true to force a " +
        "re-run, see the fresh argument.",
      inputSchema: {
        id: idParam,
        force: z.boolean().optional().describe("Re-run consolidated analysis even if it already exists, default false."),
        fresh: freshParam,
      },
    },
    async (args): Promise<CallToolResult> => {
      const { id, force, fresh } = args as any;
      const body: Record<string, unknown> = {};
      if (force !== undefined) body.force = force;
      const result = await callApi(opts, {
        method: "POST",
        path: `cases/${encodeURIComponent(id)}/analyze-consolidated`,
        body,
        timeoutMs: LONG_TIMEOUT_MS,
        idempotencyKey: computeIdempotencyKey(
          "analyze_consolidated_case",
          { id, force },
          opts.sessionSalt,
          fresh ? randomUUID() : undefined
        ),
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
        "Returns a time limited link to the official judgment PDF for a case. No AI credits consumed. " +
        "The returned pdfUrl is a directly fetchable HTTPS link on the CourtMesh API host: hand it to the " +
        "user, or fetch it, and you get the PDF. It needs no API key and no decryption, and it expires after " +
        "the returned expiresIn seconds (normally 3600). Fetching it costs no credits. Two distinct 404s: code CASE_NOT_FOUND " +
        "means no case matches the given id at all; code PDF_NOT_STORED means the case exists but has no stored " +
        "document, and comes with a hint field suggesting request_case_timeline with refresh:true, which can " +
        "fetch orders for High Court and District Court cases (tribunal documents are not fetchable via this API).",
      inputSchema: { id: idParam },
    },
    async (args): Promise<CallToolResult> => {
      const { id } = args as any;
      const result = await callApi(opts, { method: "GET", path: `cases/${encodeURIComponent(id)}/pdf`, timeoutMs: LOOKUP_TIMEOUT_MS });
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
        "the 24 character hexadecimal case id, the id field from search results, a case number will fail. " +
        "By default (refresh omitted or false) this is a STORED read: 1 credit, meta.liveFetch is false, and it " +
        "never contacts a court portal. Set refresh true to force a LIVE fetch directly from the court's own " +
        "systems instead: still 1 credit, meta.liveFetch true, available on PAYG and above only (Free tier returns " +
        "HTTP 403 LIVE_FETCH_NOT_ALLOWED), and subject to a per tier daily cap (HTTP 429 " +
        "LIVE_FETCH_LIMIT_REACHED once exhausted, with a Retry-After telling you when it resets). Supreme Court " +
        "cases return immediately with status completed and orderCount 0, since SC cases have no separate order " +
        "history in this system. District Court cases are fetched synchronously and come back completed or " +
        "failed. High Court cases usually return pending and must be polled with get_case_timeline using the " +
        "returned requestId. A live refresh can take a while against a slow court portal, so this call uses a " +
        "longer timeout than most tools. This call sends an Idempotency-Key derived from the exact " +
        "case_id/refresh arguments plus this session, so retrying this same call in this same session never " +
        "re-triggers a live fetch or re-charges credits; the identical call from a different session is never " +
        "treated as a replay of this one, and changing any argument here also runs as a new call. When a replay " +
        "happens, the result text starts with a \"Replayed: ...\" line so you can tell it apart from a freshly " +
        "computed result. Set fresh true to force a re-run, see the fresh argument.",
      inputSchema: {
        case_id: z
          .string()
          .min(1)
          .describe("24 character hexadecimal case id for the case, from the id field of a search result. A case number will not work here."),
        refresh: z
          .boolean()
          .optional()
          .describe(
            "Default false: a stored-only read, 1 credit, meta.liveFetch false, never touches a court portal. " +
              "Set true to force a live fetch from the court's own systems: also 1 credit, meta.liveFetch true, " +
              "PAYG tier or above only (403 LIVE_FETCH_NOT_ALLOWED on Free), and capped per day per tier (429 " +
              "LIVE_FETCH_LIMIT_REACHED once exhausted)."
          ),
        fresh: freshParam,
      },
    },
    async (args): Promise<CallToolResult> => {
      const { case_id, refresh, fresh } = args as any;
      const body: Record<string, unknown> = { case_id };
      if (refresh !== undefined) body.refresh = refresh;
      const result = await callApi(opts, {
        method: "POST",
        path: "request-timeline",
        body,
        timeoutMs: TIMELINE_TIMEOUT_MS,
        idempotencyKey: computeIdempotencyKey(
          "request_case_timeline",
          { case_id, refresh },
          opts.sessionSalt,
          fresh ? randomUUID() : undefined
        ),
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
        "derived from every argument here plus this session, so retrying this exact same screen in this same " +
        "session never re-charges credits; the identical screen from a different session is never treated as a " +
        "replay of this one, and changing any argument (including name, aliases or identifiers) here also runs as " +
        "a new, separately charged screen. When a replay happens, the result text starts with a \"Replayed: ...\" " +
        "line so you can tell it apart from a freshly computed result (in addition to query.name/query.aliases " +
        "coming back redacted, same as any stored record). Set fresh true to force a re-run, see the fresh " +
        "argument. Use screen_party_litigation_batch instead to screen more than one name in a single call.",
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
        fresh: freshParam,
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
        fresh,
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
        idempotencyKey: computeIdempotencyKey(
          "screen_party_litigation",
          body,
          opts.sessionSalt,
          fresh ? randomUUID() : undefined
        ),
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
        "single clean or dirty result. This call sends an Idempotency-Key derived from every argument here plus " +
        "this session, so retrying this exact same batch in this same session never re-charges credits; the " +
        "identical batch from a different session is never treated as a replay of this one, and changing any item " +
        "here also runs as a new, separately charged batch. When a replay happens, the result text starts with a " +
        "\"Replayed: ...\" line so you can tell it apart from a freshly computed result. Set fresh true to force a " +
        "re-run, see the fresh argument.",
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
        fresh: freshParam,
      },
    },
    async (args): Promise<CallToolResult> => {
      const { items, purpose, entityType, fresh } = args as any;
      const body: Record<string, unknown> = { items, purpose };
      if (entityType !== undefined) body.entityType = entityType;

      const result = await callApi(opts, {
        method: "POST",
        path: "party/screen/batch",
        body,
        timeoutMs: LONG_TIMEOUT_MS,
        idempotencyKey: computeIdempotencyKey(
          "screen_party_litigation_batch",
          body,
          opts.sessionSalt,
          fresh ? randomUUID() : undefined
        ),
      });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data, isReplayed(result.data) ? REPLAYED_NOTE : undefined);
    }
  );

  // ---------------------------------------------------------------------------
  // CNR lookup and case monitoring (0.5.0)
  //
  // Seven tools: one lookup, five watchlist tools and the change feed. Webhook
  // management is deliberately NOT exposed. A webhook is a standing instruction
  // to send account data to a URL, its signing secret is shown once and would
  // land in the chat transcript, and a URL planted by text the model read (a
  // prompt injection in a document) is a data exfiltration path. Webhooks are
  // set up once by a developer in code or the dashboard; an agent that needs
  // changes reads get_case_changes instead. None of the watchlist tools send an
  // Idempotency-Key: a replayed "add" after a "remove" within 24 hours would
  // silently do nothing. Adding is naturally idempotent (a repeat reports
  // "duplicate"), so a retry is safe without one.
  // ---------------------------------------------------------------------------

  const cnrParam = z
    .string()
    .trim()
    .min(1)
    .describe(
      "A CNR (Case Number Record), the 16 character national case identifier, for example DLHC010084212021. " +
        "Common spellings are accepted and tidied for you: lower case, spaces, hyphens, slashes and a leading " +
        '"CNR:" or "CNR No" label are all fine.'
    );

  const watchlistIdParam = z
    .string()
    .trim()
    .min(1)
    .describe("Watchlist id, starts with wl_. Get ids from list_watchlists or from create_watchlist.");

  const watchItemSchema = z.object({
    cnr: cnrParam,
    reference: z
      .string()
      .max(200)
      .optional()
      .describe("Your own id for this case, up to 200 characters, for example a loan number. It is echoed back on every change event for the case."),
    label: z.string().max(200).optional().describe("A short display label, up to 200 characters."),
  });

  function normalizeItems(items: Array<{ cnr: string; reference?: string; label?: string }>) {
    return items.map((item) => ({ ...item, cnr: cnrForRequest(item.cnr) }));
  }

  // 19. lookup_case_by_cnr ----------------------------------------------
  server.registerTool(
    "lookup_case_by_cnr",
    {
      title: "Look Up Case By CNR",
      description:
        "Finds one case from its CNR (the 16 character national case number record, for example " +
        "DLHC010084212021). Use this when the user gives you a CNR; use search_indian_court_cases for names, " +
        "citations or keywords. COSTS 1 CREDIT, charged only when a case record is actually returned; not found and " +
        "pending cost nothing. The result's data.status is one of: found (data.case is the full case record, " +
        "same shape as get_case, including caseStatus, caseStage, nextHearingDate, lastListedOn and orderCount); " +
        "pending (a live fetch from the court is running: wait a few seconds and call this tool again with the same " +
        "arguments; data.requestId is opaque and does not work with get_case_timeline); or, when the CNR is not in " +
        "our records and fetch was not set, a 404 Not found error (a Supreme Court CNR we do not hold is always " +
        "404, it cannot be fetched live). In that last case, ask the user before retrying with fetch true, " +
        "because a live fetch is limited per day and the record, once it lands, costs 1 credit. If the court " +
        "already had nothing for this CNR in the last 24 hours, fetch true does not ask it again: the call is a 404 " +
        "straight away, so do not keep retrying; tell the user to check the CNR or try tomorrow. A case that was " +
        "taken down at a party's request is not available and is reported as not found. Typical flow: call with fetch false; if " +
        "not found and the user wants it, call again with fetch true; then repeat the call until status is found. " +
        "To be told when this case changes later, add it with add_cases_to_watchlist.",
      inputSchema: {
        cnr: cnrParam,
        fetch: z
          .boolean()
          .optional()
          .describe(
            "Default false. Set true only if a previous call said the CNR is not found: starts a live fetch from " +
              "the court's own system for a case we do not hold yet. The call that starts the fetch is free and returns " +
              "pending; the later call that returns the record costs 1 credit, and a fetch the court cannot satisfy is free. It shares " +
              "the per day live fetch cap with request_case_timeline refresh (HTTP 429 LIVE_FETCH_LIMIT_REACHED once " +
              "exhausted). Returns status pending; call again shortly."
          ),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { cnr, fetch } = args as any;
      const result = await callApi(opts, {
        method: "GET",
        path: `cases/by-cnr/${encodeURIComponent(cnrForRequest(cnr))}`,
        query: fetch ? { fetch: "true" } : undefined,
        timeoutMs: LOOKUP_TIMEOUT_MS,
      });
      if (!result.ok) return errorResult(result.message);
      const status = result.data?.data?.status;
      const note =
        status === "pending"
          ? "The live fetch is still running. Call lookup_case_by_cnr again with the same arguments in a few seconds."
          : undefined;
      return envelopeResult(result.data, note);
    }
  );

  // 20. create_watchlist ------------------------------------------------
  server.registerTool(
    "create_watchlist",
    {
      title: "Create Watchlist",
      description:
        "Creates a named watchlist and, optionally, starts watching up to 100 cases (by CNR) in it. Monitoring " +
        "means CourtMesh checks every watched case at least once a day and records a change event when " +
        "something happens. FREE: creating a watchlist and watching cases cost no credits; the daily checks are " +
        "included. Limits per account: a cap on total distinct watched cases (Free 10, Pay As You Go 1,000, Scale 10,000, " +
        "Enterprise by contract), a daily allowance on how many cases can be added (Free 50, Pay As You Go 5,000, " +
        "Scale 50,000, Enterprise 500,000, resetting at midnight IST) and at most 50 watchlists, so reuse an existing watchlist (list_watchlists) rather " +
        "than creating a new one for every case. Each CNR in items gets a result: watching (already in our records), " +
        "pending (not in our records yet, so a live fetch was started and it will become watching), invalid (not a " +
        "valid CNR), duplicate (already on this list), cap_exceeded (over the account cap, over the daily add " +
        "allowance, or over the daily limit on adding cases we do not hold yet: Free 20, Pay As You Go 500, Scale " +
        "5,000; the item message says which) or not_found (the court has no such case, the court had nothing for " +
        "it in the last 24 hours so it is not asked again until tomorrow, the case was taken down at a party's " +
        "request, or a Supreme Court CNR we do not hold). Cases that end up not_found still count toward the cap " +
        "until removed. A partial success is still a success: read the per item results. Each case produces one " +
        "case.tracking_started event with its current state once its first fresh check completes (straight away if " +
        "our record is already current), not a flood of historical events, so it can arrive a little after the add. " +
        "Read changes later with get_case_changes.",
      inputSchema: {
        name: z.string().trim().min(1).max(100).describe("Watchlist name, 1 to 100 characters, for example Loan book or Client matters."),
        items: z
          .array(watchItemSchema)
          .max(100)
          .optional()
          .describe("Up to 100 cases to start watching. More can be added later with add_cases_to_watchlist."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { name, items } = args as any;
      const body: Record<string, unknown> = { name };
      if (items !== undefined) body.items = normalizeItems(items);
      const result = await callApi(opts, { method: "POST", path: "watchlists", body, timeoutMs: LOOKUP_TIMEOUT_MS });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 21. list_watchlists -------------------------------------------------
  server.registerTool(
    "list_watchlists",
    {
      title: "List Watchlists",
      description:
        "Lists this account's watchlists: id (starts with wl_), name, itemCount, createdAt, updatedAt and metadata. " +
        "FREE, no credits. Call this first to find an existing watchlist id before creating a new watchlist. " +
        "Results are paginated: if the result mentions a next page cursor, pass it back as cursor to get more.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Watchlists per page, 1 to 100."),
        cursor: z.string().trim().optional().describe("The pagination.nextCursor from a previous call, passed back unmodified."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { limit, cursor } = args as any;
      const result = await callApi(opts, { method: "GET", path: "watchlists", query: { limit, cursor }, timeoutMs: LOOKUP_TIMEOUT_MS });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 22. add_cases_to_watchlist ------------------------------------------
  server.registerTool(
    "add_cases_to_watchlist",
    {
      title: "Add Cases To Watchlist",
      description:
        "Starts watching 1 to 100 cases (by CNR) on an existing watchlist. FREE, no credits; daily checks are " +
        "included, subject to the account's watched case cap. Each CNR gets a result: watching (already in our " +
        "records), pending (not in our records yet, so a live fetch was started; it becomes watching when the case " +
        "lands), invalid (not a valid CNR), duplicate (already on this list), cap_exceeded (the account is at its " +
        "watched case cap, its daily add allowance (Free 50, Pay As You Go 5,000, Scale 50,000, Enterprise 500,000) " +
        "or its daily limit on adding cases we do not hold yet, so remove cases you no longer need " +
        "with remove_case_from_watchlist, or retry tomorrow; the item message says which) or not_found (the court " +
        "has no such case, the court had nothing for it in the last 24 hours so it is not asked again until " +
        "tomorrow, the case was taken down at a party's request, or a Supreme Court CNR we do not hold). A case " +
        "that is not_found still counts toward the cap until removed. If the cap " +
        "is already full and you send a new CNR the call fails with 403 WATCH_CAP_EXCEEDED. A partial success is still a success: always read the per item results and " +
        "tell the user about any that were not watching or pending. Each watched case produces a " +
        "case.tracking_started event with its current state once its first fresh check completes (straight away " +
        "if our record is already current); later changes (new orders, hearing date, status, stage, disposal) are read " +
        "with get_case_changes. Repeating a call is safe: already watched cases are reported as duplicate.",
      inputSchema: {
        watchlist_id: watchlistIdParam,
        items: z.array(watchItemSchema).min(1).max(100).describe("The cases to watch, 1 to 100."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { watchlist_id, items } = args as any;
      const result = await callApi(opts, {
        method: "POST",
        path: `watchlists/${encodeURIComponent(watchlist_id)}/items`,
        body: { items: normalizeItems(items) },
        timeoutMs: LOOKUP_TIMEOUT_MS,
      });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 23. remove_case_from_watchlist --------------------------------------
  server.registerTool(
    "remove_case_from_watchlist",
    {
      title: "Remove Case From Watchlist",
      description:
        "Stops watching one case on one watchlist. FREE, no credits. This frees one slot of the account's watched " +
        "case cap (the cap counts every case on every watchlist). A CNR that is not on that watchlist is a 404 " +
        "ITEM_NOT_FOUND. Change events already recorded for the case stay " +
        "readable in get_case_changes. Only call this when the user has asked to stop watching that case.",
      inputSchema: { watchlist_id: watchlistIdParam, cnr: cnrParam },
    },
    async (args): Promise<CallToolResult> => {
      const { watchlist_id, cnr } = args as any;
      const result = await callApi(opts, {
        method: "DELETE",
        path: `watchlists/${encodeURIComponent(watchlist_id)}/items/${encodeURIComponent(cnrForRequest(cnr))}`,
        timeoutMs: LOOKUP_TIMEOUT_MS,
      });
      if (!result.ok) return errorResult(result.message);
      return textResult(result.data === undefined || result.data === null ? { success: true, removed: true } : result.data);
    }
  );

  // 24. list_watchlist_cases --------------------------------------------
  server.registerTool(
    "list_watchlist_cases",
    {
      title: "List Watchlist Cases",
      description:
        "Lists the cases on one watchlist with their current monitoring state. FREE, no credits. Each item has: " +
        "cnr, reference and label (the caller's own), status (watching, pending, not_found, error or unavailable), caseId, " +
        "court, title, lastCheckedAt, lastChangedAt, addedAt and a snapshot of caseStatus, caseStage, " +
        "nextHearingDate, lastListedOn, orderCount, latestOrderDate and disposalNature (dates are YYYY-MM-DD). " +
        "unavailable means the case was taken down at a party's request: caseId, court, title, snapshot, " +
        "lastCheckedAt and lastChangedAt are all null and no events are sent, so tell the user it is no longer " +
        "available rather than treating the nulls as missing data. Use this to answer " +
        "\"what is the next hearing date for everything I am watching\" without reading the change feed. Filter " +
        "with status, for example pending to see which cases are still being fetched. Results are paginated: if " +
        "the result mentions a next page cursor, pass it back as cursor.",
      inputSchema: {
        watchlist_id: watchlistIdParam,
        status: z.enum(["watching", "pending", "not_found", "error", "unavailable"]).optional().describe("Only items with this status."),
        limit: z.number().int().min(1).max(100).optional().describe("Items per page, 1 to 100."),
        cursor: z.string().trim().optional().describe("The pagination.nextCursor from a previous call, passed back unmodified."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { watchlist_id, status, limit, cursor } = args as any;
      const result = await callApi(opts, {
        method: "GET",
        path: `watchlists/${encodeURIComponent(watchlist_id)}/items`,
        query: { status, limit, cursor },
        timeoutMs: LOOKUP_TIMEOUT_MS,
      });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 25. get_case_changes ------------------------------------------------
  server.registerTool(
    "get_case_changes",
    {
      title: "Get Case Changes",
      description:
        "Reads the change feed for the cases this account is watching: new orders, hearing date changes, status " +
        "and stage changes, disposals, and tracking started or case not found events. Oldest first. COSTS 1 CREDIT " +
        "per page that has at least one event (up to 100 events per page); an empty page is free, so polling " +
        "when nothing has changed costs nothing. Each event has id, type (case.tracking_started, case.order_added, " +
        "case.hearing_date_changed, case.status_changed, case.stage_changed, case.disposed, case.not_found), " +
        "createdAt, cnr, caseId, the watchlists it belongs to (with the caller's reference) and data (for example " +
        "previous and current values, plus a snapshot of the case). To get only what is new since the last " +
        "call, pass back pagination.nextCursor as cursor: it is returned even when the page is empty, so always " +
        "remember the latest one; cursors are opaque, so never build or edit one. With no cursor, pass since (an ISO " +
        "timestamp, such as the start of today) to bound the history, otherwise you start from the oldest retained " +
        "event; events are kept for 90 days and appear in the feed about 2 seconds after they happen. case.tracking_started " +
        "is sent after a case's first fresh check, not at the moment it is added. When many orders arrive at once " +
        "only the newest 20 are announced, and an order dated more than 7 days before watching began is never " +
        "announced. Dates are YYYY-MM-DD. A case taken down at a party's request sends no events. If " +
        "pagination.hasMore is true there is another page, which costs another credit: fetch it only if you need it. " +
        "Pass watchlist_id to restrict to one watchlist, and types or cnr to narrow further, which keeps the cost " +
        "down.",
      inputSchema: {
        watchlist_id: watchlistIdParam.optional().describe("Only events for this watchlist. Omit for all watchlists."),
        since: z
          .string()
          .trim()
          .optional()
          .describe("ISO 8601 timestamp, for example 2026-11-01T00:00:00Z. Used only when no cursor is given."),
        cursor: z.string().trim().optional().describe("The pagination.nextCursor from a previous call, passed back unmodified. Takes priority over since."),
        types: z
          .array(
            z.enum([
              "case.tracking_started",
              "case.order_added",
              "case.hearing_date_changed",
              "case.status_changed",
              "case.stage_changed",
              "case.disposed",
              "case.not_found",
            ])
          )
          .optional()
          .describe("Only these event types. Omit for all."),
        cnr: cnrParam.optional().describe("Only events for this CNR."),
        limit: z.number().int().min(1).max(100).optional().describe("Events per page, 1 to 100, default 100."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { watchlist_id, since, cursor, types, cnr, limit } = args as any;
      const result = await callApi(opts, {
        method: "GET",
        path: watchlist_id ? `watchlists/${encodeURIComponent(watchlist_id)}/events` : "changes",
        query: {
          since,
          cursor,
          types: Array.isArray(types) ? types.join(",") : types,
          cnr: cnr === undefined ? undefined : cnrForRequest(cnr),
          limit,
        },
        timeoutMs: LOOKUP_TIMEOUT_MS,
      });
      if (!result.ok) return errorResult(result.message);
      const next = result.data?.pagination?.nextCursor;
      const note =
        typeof next === "string" && next.length > 0
          ? "Remember pagination.nextCursor: pass it back as cursor next time to read only newer events."
          : undefined;
      return envelopeResult(result.data, note);
    }
  );

  // ---------------------------------------------------------------------------
  // Cause lists
  //
  // Four tools: listings of the account's matters, listings of one matter, the
  // published list of one court, and the check of watched CNRs. Every result
  // carries _meta.provenance.untrusted_content because the text comes from
  // court lists. Only listings that were found are ever reported: an empty
  // result is never a statement that a case is absent from a list.
  // ---------------------------------------------------------------------------

  // Read only, but every call is charged: a repeat is not free, so idempotentHint is false.
  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
  const clock = () => (opts.now ? opts.now() : Date.now());

  const dateParam = (name: string, extra: string) =>
    z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, `${name} must be a date written YYYY-MM-DD.`)
      .optional()
      .describe(`${name === "from" ? "First" : "Last"} date, YYYY-MM-DD (Indian calendar). ${extra}`);

  const NOT_PROOF =
    "An empty result or a missing row is NOT proof that a case is not listed: say what was read and suggest confirming " +
    "against the court's own list when it matters. Never tell the user a case is not listed.";

  const COURT_LIST_CACHE_MS = 5 * 60_000;
  const courtListCache = new Map<string, { body: any; expires: number }>();

  const untrusted = (result: CallToolResult): CallToolResult => ({ ...result, _meta: UNTRUSTED_META });

  function invalid(problems: string[]): CallToolResult {
    return errorResult(
      `Request rejected before sending: ${problems.join(" ")} Fix the field values and call again; repeating the same call will fail the same way.`
    );
  }

  // 26. list_cause_listings -----------------------------------------------
  server.registerTool(
    "list_cause_listings",
    {
      title: "List Cause List Listings",
      description:
        "Lists the hearing listings found on court cause lists for the matters in this account (My Cases), within " +
        "a date range of at most 31 days (default: today and the next 7 days). Each listing has id, matterId, " +
        "matterTitle, date, courtKey (usable with get_court_cause_list), court (name, courtNo, judges), item, section, " +
        "purpose, listType, stage, caseText (the case number as written on the list; null on a related_key match), matchedBy (cnr, diary, key or related_key), " +
        "relation (set when the item is an application or connected case rather than the matter itself), fetchedAt " +
        "and firstSeenAt. COSTS 1 CREDIT per successful call; a failed call is not charged. Needs the causelist API key " +
        "scope and an account with cause lists enabled. Paginated: pages start at 1; when the result says more " +
        "results are available, call again with the next page. " + NOT_PROOF + " " + PROVENANCE_NOTE,
      inputSchema: {
        from: dateParam("from", "Send together with to, or omit both."),
        to: dateParam("to", `At most ${LISTINGS_MAX_DAYS} days after from.`),
        page: z.number().int().min(1).max(100000).optional().describe("Page number, from 1. Default 1."),
        limit: z.number().int().min(1).max(100).optional().describe("Listings per page, 1 to 100 and no more than the plan's page size cap. Default: the lower of 50 and the plan's page size cap."),
      },
      annotations: READ_ONLY,
    },
    async (args, extra): Promise<CallToolResult> => {
      const { from, to, page, limit } = args as any;
      const problems = dateRangeProblems(from, to, LISTINGS_MAX_DAYS);
      if (problems.length > 0) return invalid(problems);
      const result = await callApi(opts, {
        method: "GET",
        path: "cause-lists/listings",
        query: { from, to, page, limit },
        timeoutMs: LOOKUP_TIMEOUT_MS,
        signal: extra?.signal,
      });
      if (!result.ok) return errorResult(result.message);
      const p = result.data?.pagination;
      const nextPage = p?.hasMore && typeof p.page === "number" ? p.page + 1 : undefined;
      const notes = [
        nextPage !== undefined ? `More results are available: call list_cause_listings again with page ${nextPage} and the same dates and limit.` : undefined,
        Array.isArray(result.data?.data) && result.data.data.length === 0
          ? `No listings were found for ${from && to ? `${from} to ${to}` : "the default range (today and the next 7 days)"} among the matters in this account. This does not show that no matter is listed.`
          : undefined,
        PROVENANCE_NOTE,
      ].filter((n): n is string => Boolean(n));
      const out = envelopeResult(result.data, notes.join("\n"));
      const size = (out.content[0] as any).text.length;
      if (size > MAX_RESULT_CHARS) {
        const half = Math.max(1, Math.floor((limit ?? 50) / 2));
        return errorResult(
          `result_too_large: this page is too large to return whole. Call list_cause_listings again with limit ${half}` +
            `${from && to ? `, from ${from}, to ${to}` : ""}${page ? `, page ${page}` : ""}. The page was charged; the smaller call is charged again.`
        );
      }
      return untrusted(out);
    }
  );

  // 27. list_matter_cause_listings ----------------------------------------
  server.registerTool(
    "list_matter_cause_listings",
    {
      title: "List Cause List Listings For A Matter",
      description:
        "Lists the hearing listings found for ONE matter in this account (My Cases), within a date range of at most " +
        "31 days (default: today and the next 7 days). matter_id is the 24 character hexadecimal id of the matter " +
        "(the matterId on a listing from list_cause_listings). Returns the matter (id, title, courtKey) and its " +
        "listings in the same shape as list_cause_listings. COSTS 1 CREDIT per successful call; an unknown matter, " +
        "an account without cause list access or a temporary outage is not charged. Needs the causelist API key scope. " +
        NOT_PROOF + " " + PROVENANCE_NOTE,
      inputSchema: {
        matter_id: z
          .string()
          .trim()
          .regex(MATTER_ID_PATTERN, "matter_id must be a 24 character hexadecimal id.")
          .describe("The 24 character hexadecimal id of the matter."),
        from: dateParam("from", "Send together with to, or omit both."),
        to: dateParam("to", `At most ${LISTINGS_MAX_DAYS} days after from.`),
      },
      annotations: READ_ONLY,
    },
    async (args, extra): Promise<CallToolResult> => {
      const { matter_id, from, to } = args as any;
      const problems = dateRangeProblems(from, to, LISTINGS_MAX_DAYS);
      if (problems.length > 0) return invalid(problems);
      const result = await callApi(opts, {
        method: "GET",
        path: `matters/${encodeURIComponent(matter_id)}/cause-listings`,
        query: { from, to },
        timeoutMs: LOOKUP_TIMEOUT_MS,
        signal: extra?.signal,
      });
      if (!result.ok) return errorResult(result.message);
      const empty = Array.isArray(result.data?.data?.listings) && result.data.data.listings.length === 0;
      const notes = [
        empty
          ? `No listings were found for this matter in ${from && to ? `${from} to ${to}` : "the default range (today and the next 7 days)"}. This does not show that the matter is not listed.`
          : undefined,
        PROVENANCE_NOTE,
      ].filter((n): n is string => Boolean(n));
      const out = envelopeResult(result.data, notes.join("\n"));
      if ((out.content[0] as any).text.length > MAX_RESULT_CHARS) {
        return errorResult(
          "result_too_large: this matter has too many listings in the range to return whole. Call list_matter_cause_listings again with a shorter from to range (for example 7 days). The call was charged; the smaller call is charged again."
        );
      }
      return untrusted(out);
    }
  );

  // 28. get_court_cause_list ----------------------------------------------
  server.registerTool(
    "get_court_cause_list",
    {
      title: "Get Court Cause List",
      description:
        "Reads the published cause list of one court for one date, for a court where this account has an open " +
        "matter. court_key is `SC`, `HC:<state>:<bench>` or `DC:<state>:<district>:<complex>:<establishment>:<court number>` " +
        "(digits only); use the courtKey of a listing from list_cause_listings. data.status says what was read: ok and " +
        "partial carry rows (partial means some parts of the list could not be read; complete says whether every part " +
        "was); none, empty, not_published, invalid_court and unavailable carry no rows. COSTS 1 CREDIT only when status " +
        "is ok or partial; every other status is a 200 that costs 0 (meta.creditsCharged says so), though the call " +
        "needs 1 credit available when it starts. A court with no open matter of yours is a 404 COURT_LIST_NOT_FOUND, " +
        "not charged. A list can have thousands of rows: rows are returned in pages of limit (default 200, max 500) " +
        "from offset, and the result gives rowsTotal and nextOffset (null when done); later pages of the same list read " +
        "within 5 minutes in this session are not charged again. Each row has item, section, " +
        "purpose, listType, courtNo, courtName, judges, caseText, caseType, caseNumber, caseYear, cnr, diary fields, " +
        "petitioner, respondent, advocates, stage and related items; a restricted row has no party or advocate " +
        "fields. Needs the causelist API key scope. status empty or unavailable, or a row you do not see, is NOT proof " +
        "that a case is not listed. " + PROVENANCE_NOTE,
      inputSchema: {
        court_key: z
          .string()
          .trim()
          .regex(COURT_KEY_PATTERN, "court_key must be SC, HC:<state>:<bench> or DC:<state>:<district>:<complex>:<establishment>:<court number>, digits only.")
          .describe("SC, HC:<state>:<bench> or DC:<state>:<district>:<complex>:<establishment>:<court number>, digits only. Example: DC:99:1:9900001:1:1."),
        date: z
          .string()
          .trim()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be a date written YYYY-MM-DD.")
          .describe("Date of the list, YYYY-MM-DD (Indian calendar)."),
        offset: z.number().int().min(0).max(1_000_000).optional().describe("Row to start from, default 0. Use nextOffset from the previous call."),
        limit: z.number().int().min(1).max(500).optional().describe("Rows per call, 1 to 500, default 200."),
      },
      annotations: READ_ONLY,
    },
    async (args, extra): Promise<CallToolResult> => {
      const { court_key, date, offset, limit } = args as any;
      if (!isIsoDate(date)) return invalid(["date: date must be a real date written YYYY-MM-DD."]);
      // Later pages of a list already paid for in this session are served from memory: re-calling the
      // API for every page of rows would charge 1 credit each time for the same list.
      const cacheKey = createHash("sha256")
        .update(`${opts.sessionSalt}:${getApiKeyOverride() ?? opts.apiKey ?? ""}:${court_key}:${date}`)
        .digest("hex");
      const now = clock();
      for (const [k, v] of courtListCache) if (v.expires <= now) courtListCache.delete(k);
      const cached = (offset ?? 0) > 0 ? courtListCache.get(cacheKey) : undefined;
      let result: { ok: true; data: any } | { ok: false; message: string };
      let fromCache = false;
      let cacheExpires = 0;
      if (cached) {
        // Pages served from this session are free: say so in meta, not just in the text.
        result = { ok: true, data: { ...cached.body, meta: { ...(cached.body?.meta ?? {}), creditsCharged: 0, servedFromSession: true } } };
        fromCache = true;
        cacheExpires = cached.expires;
      } else {
        result = await callApi(opts, {
          method: "GET",
          path: "cause-lists/court",
          query: { courtKey: court_key, date },
          timeoutMs: LOOKUP_TIMEOUT_MS,
          signal: extra?.signal,
        });
        if (result.ok && (result.data?.data?.status === "ok" || result.data?.data?.status === "partial")) {
          if (courtListCache.size >= 20) courtListCache.delete(courtListCache.keys().next().value as string);
          cacheExpires = now + COURT_LIST_CACHE_MS;
          courtListCache.set(cacheKey, { body: result.data, expires: cacheExpires });
        }
      }
      if (!result.ok) return errorResult(result.message);
      const list = result.data?.data;
      const allRows: unknown[] = Array.isArray(list?.rows) ? list.rows : [];
      const start = Math.min(offset ?? 0, allRows.length);
      let take = limit ?? 200;
      const build = (n: number) => {
        const end = Math.min(start + n, allRows.length);
        const paged = {
          ...result.data,
          data: { ...list, rows: allRows.slice(start, end), rowsTotal: allRows.length, rowsOffset: start, nextOffset: end < allRows.length ? end : null },
        };
        const notes = [
          end < allRows.length ? `Rows ${start} to ${end - 1} of ${allRows.length}. Call get_court_cause_list again with the same court_key and date and offset ${end} for the next rows: for ${describeRemaining(cacheExpires - now)} more those are served from this session and are not charged again.` : undefined,
          fromCache ? `These rows were served from the list already read in this session (meta.servedFromSession); no new charge was made. The stored list stays available for ${describeRemaining(cacheExpires - now)} more.` : undefined,
          list?.status === "empty" || list?.status === "none" || list?.status === "unavailable" || list?.status === "not_published"
            ? `Status ${list.status}: no rows were read for this court and date. This does not show that any case is not listed.`
            : undefined,
          list && list.complete === false && allRows.length > 0 ? "complete is false: only part of this list was read, so a case missing from these rows may still be on the full list." : undefined,
          PROVENANCE_NOTE,
        ].filter((n): n is string => Boolean(n));
        return envelopeResult(paged, notes.join("\n"));
      };
      let out = build(take);
      while ((out.content[0] as any).text.length > MAX_RESULT_CHARS && take > 1) {
        take = Math.max(1, Math.floor(take / 2));
        out = build(take);
      }
      return untrusted(out);
    }
  );

  // 29. check_cause_list_for_cnrs -----------------------------------------
  server.registerTool(
    "check_cause_list_for_cnrs",
    {
      title: "Check Watched Cases On Cause Lists",
      description:
        "Checks whether 1 to 100 cases (by CNR) that this account WATCHES (see add_cases_to_watchlist) appear on a " +
        "cause list that CourtMesh already holds, for a range of at most 7 days (default: today and tomorrow, Indian " +
        "calendar). It never contacts a court: it reads stored lists only. COSTS 1 CREDIT per CNR whose status is " +
        "listed or no_entry_found, settled once for the whole call; every other status is free. The call also needs at " +
        "least 1 credit available when it starts: a balance below the number of watched CNRs in it is refused (402). Needs the causelist API key scope. The data has results, summary, and from and to (the dates looked at, including " +
        "the default range once resolved). Each result has cnr, status, reason, courtKey (null when no court could be " +
        "identified or the CNR is not watched), dates " +
        "(per date: date, status, complete, fetchedAt) and listings (date, courtKey, court, item, section, purpose, " +
        "listType, stage, caseText, matchedBy, relation, fetchedAt; matchedBy is cnr, diary, key or related_key, and " +
        "courtKey and caseText can be null). Statuses: listed (a row of this case was found; read " +
        "listings); no_entry_found (a list was read and no row was recognised: this does NOT prove the case is not " +
        "listed, because the list may be partial (see dates[].complete) or the entry may not be recognisable, so " +
        "never tell the user the case is not listed, say only that no entry was found in the lists read and that the " +
        "court's own list should be checked); list_not_read (no list was held for those dates, so nothing is known; for a District Court it can also " +
        "mean the list of the case's own courtroom could not be confirmed, in which case dates[].status is none); " +
        "cannot_check (reason says why: pending, record_unavailable, court_not_supported, or a court identification " +
        "reason: no_case_identity, no_court_key, no_court_number, invalid_court_key, unsupported_court); not_watched (this account does " +
        "not watch the CNR: add it first). A summary gives the count of each status. Limits: 1 to 100 CNRs, and distinct CNRs " +
        "(repeats are ignored) times the dates in the range (inclusive; 2 by default) at most 300. A temporary outage is a 502 for the " +
        "whole call, not charged. A 402 can also arrive after the answer is ready, when the credits due cannot be " +
        "settled: no results are returned, so check the balance rather than repeating blindly. A 503 with code " +
        "SETTLEMENT_UNCONFIRMED means the answer was ready but the charge outcome is unknown and no results were " +
        "returned: do not retry; check the balance (get_api_usage) first, and note that repeating the call with the " +
        "same Idempotency-Key is refused with 409 IDEMPOTENCY_IN_PROGRESS for up to 24 hours (a call with changed " +
        "arguments or fresh true is a new request). A 503 ENTITLEMENT_UNAVAILABLE ran nothing and is safe to retry Repeating an identical call within the same 5 minute window in this same session returns the stored " +
        "result and is not charged again; the result then says it was replayed and may be out of date, and fresh true " +
        "reads the lists again, charged as above. A call after that window reads the lists again. " + PROVENANCE_NOTE,
      inputSchema: {
        cnrs: z.array(z.string().trim().min(1)).min(1).max(100).describe("1 to 100 CNRs, any common spelling (spaces, hyphens, a CNR: label are tidied for you)."),
        from: dateParam("from", "Send together with to, or omit both for today and tomorrow."),
        to: dateParam("to", `At most ${CHECK_MAX_DAYS} days after from.`),
        fresh: freshParam,
      },
      annotations: READ_ONLY,
    },
    async (args, extra): Promise<CallToolResult> => {
      const { cnrs, from, to, fresh } = args as any;
      const problems = dateRangeProblems(from, to, CHECK_MAX_DAYS);
      if (problems.length > 0) return invalid(problems);
      const badCnrs = (cnrs as string[])
        .map((c, i) => (normalizeCnr(c) === null ? `cnrs.${i}: "${String(c).slice(0, 64)}" is not a valid CNR. A CNR has 16 characters, for example ZZAB010000022024.` : undefined))
        .filter((m): m is string => Boolean(m));
      if (badCnrs.length > 0) return invalid(badCnrs.slice(0, 5));
      const limitProblem = cnrDatesProblem(cnrs as string[], from, to);
      if (limitProblem) return invalid([limitProblem]);
      const nowMs = clock();
      // Resolve the default range (today and tomorrow, IST) before hashing, so the key follows the dates
      // that are actually asked about, and send the resolved dates so the request is explicit.
      const range = from !== undefined && to !== undefined ? { from, to } : defaultCheckRange(nowMs);
      const body: Record<string, unknown> = { cnrs: (cnrs as string[]).map(cnrForRequest), from: range.from, to: range.to };
      // A 5 minute bucket in the key: a repeat inside the bucket replays (no double charge on a retry),
      // a call in a later bucket is a new request that reads the lists again.
      const bucket = Math.floor(nowMs / CHECK_REPLAY_BUCKET_MS);
      const result = await callApi(opts, {
        method: "POST",
        path: "cause-lists/check",
        body,
        timeoutMs: LOOKUP_TIMEOUT_MS,
        signal: extra?.signal,
        idempotencyKey: computeIdempotencyKey(
          "check_cause_list_for_cnrs",
          { ...body, bucket },
          opts.sessionSalt,
          fresh ? randomUUID() : undefined
        ),
      });
      if (!result.ok) return errorResult(result.message);
      const notes: string[] = [];
      if (isReplayed(result.data)) {
        const wf = result.data?.data?.from ?? range.from;
        const wt = result.data?.data?.to ?? range.to;
        notes.push(
          `Replayed: this result was stored by an identical call a few minutes ago in this session, was not charged again, and may be out of date. It covers ${wf} to ${wt}. Call again with fresh true to read the lists again (charged as above).`
        );
      }
      const summary = result.data?.data?.summary;
      if (summary && summary.noEntryFound > 0) {
        notes.push(
          "no_entry_found does not prove a case is not listed. Report it as: no entry was found in the lists read, and check the court's own list."
        );
      }
      notes.push(PROVENANCE_NOTE);
      let out = envelopeResult(result.data, notes.join("\n"));
      if ((out.content[0] as any).text.length > MAX_RESULT_CHARS) {
        let keep = 3;
        let compact = compactCheckData(result.data?.data, keep);
        out = envelopeResult({ ...result.data, data: compact.data }, "");
        while ((out.content[0] as any).text.length > MAX_RESULT_CHARS && keep > 0) {
          keep = keep > 1 ? 1 : 0;
          compact = compactCheckData(result.data?.data, keep);
          out = envelopeResult({ ...result.data, data: compact.data }, "");
        }
        notes.push(
          `The full result was too large, so per date detail is omitted and at most ${keep} listings are shown per CNR (listingCount gives the real number; ${compact.omittedListings} listings left out). To see everything, call again with fewer CNRs and fresh true; that is charged again.`
        );
        out = envelopeResult({ ...result.data, data: compact.data }, notes.join("\n"));
      }
      return untrusted(out);
    }
  );
}

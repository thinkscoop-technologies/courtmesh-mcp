/**
 * Tool definitions and handlers for the CourtMesh MCP server.
 *
 * Each tool wraps one CourtMesh REST endpoint. Handlers never throw: every
 * failure path (network error, timeout, HTTP error status, or the
 * success:false in body quirk on /search/cases/semantic) is converted into
 * an MCP tool result with isError: true and a readable text message, so the
 * calling model can recover instead of the whole turn failing.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CourtMeshApiError, DEFAULT_TIMEOUT_MS, LONG_TIMEOUT_MS, request } from "./client.js";
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
  if (pagination.nextCursor !== undefined) {
    parts.push(`nextCursor for searchAfter on the next call: ${JSON.stringify(pagination.nextCursor)}`);
  }
  return parts.length > 0 ? `Pagination: ${parts.join(", ")}.` : undefined;
}

/**
 * Runs one CourtMesh API call and returns either the parsed envelope or a
 * ready to display error string. Never throws.
 */
async function callApi(
  opts: ToolServerOptions,
  reqOpts: { method?: "GET" | "POST"; path: string; query?: Record<string, any>; body?: unknown; timeoutMs?: number }
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

/** Wraps an envelope response {data, meta, pagination} into a tool result. */
function envelopeResult(body: any): CallToolResult {
  const out: Record<string, unknown> = {};
  if (body?.data !== undefined) out.data = body.data;
  if (body?.meta !== undefined) out.meta = body.meta;
  if (body?.pagination !== undefined) out.pagination = body.pagination;
  return textResult(Object.keys(out).length > 0 ? out : body, paginationNote(body?.pagination));
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
        "Note: the caseNumber field is accepted and echoed back but does not actually filter results, put case " +
        "number text in query instead. Note: sortBy only accepts relevance or date at the validation layer, but " +
        "the underlying search engine only understands relevance, recent or oldest internally, so date is accepted " +
        "yet may not reorder results as expected.",
      inputSchema: {
        query: z.string().trim().min(1).describe("Search text: keywords, a phrase, a case number, or a party name."),
        court: stringOrArray("Court name or list of court names to filter by."),
        year: z
          .union([yearValue, z.array(yearValue)])
          .optional()
          .describe("Year or list of years, each 1947 to the current year, as an integer or a 4 digit string."),
        caseType: stringOrArray("Case type or list of case types to filter by."),
        caseNumber: stringOrArray(
          "Case number or list of case numbers. Accepted and echoed back in the response meta.filters, but this " +
            "does not actually filter results in the current API. Put the case number in query instead."
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
        limit: z.number().int().min(1).max(100).optional().describe("Results per page, 1 to 100, default 20."),
        sortBy: z
          .enum(["relevance", "date"])
          .optional()
          .describe(
            "Sort order, default relevance. Only relevance and date pass validation here; see the tool " +
              "description for a real behaviour caveat about date."
          ),
        searchAfter: z
          .string()
          .optional()
          .describe(
            "Deep pagination cursor. Pass back the JSON encoded pagination.nextCursor array from a previous " +
              "response. Prefer this over page for paging beyond the first few thousand results."
          ),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { query, court, year, caseType, caseNumber, judgeName, judges, judge, fromDate, toDate, page, limit, sortBy, searchAfter } =
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
      if (searchAfter !== undefined) body.searchAfter = searchAfter;

      const result = await callApi(opts, { method: "POST", path: "search/cases", body, timeoutMs: DEFAULT_TIMEOUT_MS });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
    }
  );

  // 2. semantic_search_cases ----------------------------------------------
  server.registerTool(
    "semantic_search_cases",
    {
      title: "Semantic Search Cases",
      description:
        "AI vector search over the roughly 2M case subset that has embeddings, out of the full 310M plus corpus. " +
        "CONSUMES AI CREDITS. Prefer this over search_indian_court_cases for natural language questions about " +
        "legal concepts, fact patterns or doctrines, where exact keywords will not match. Slower, a single call " +
        "can take a minute or more. Real behaviour note: this endpoint's validation layer also accepts top level " +
        "court, year, caseType, caseNumber, judgeName, judges, judge, fromDate and toDate fields, but the handler " +
        "silently ignores all of them, only query, page, limit and filters are actually used, so this tool only " +
        "exposes those. Put any filtering inside the filters object instead. Another quirk: if the cleaned query " +
        "text ends up shorter than 3 characters after internal processing, the service falls back to a plain " +
        "keyword search and marks the response with meta.fallbackMode = \"opensearch\".",
      inputSchema: {
        query: z.string().trim().min(3).describe("Natural language question or description, minimum 3 characters."),
        page: z.number().int().min(1).optional().describe("Page number, default 1."),
        limit: z.number().int().min(1).max(100).optional().describe("Results per page, 1 to 100, default 20, clamped to 100 server side."),
        filters: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Free form filter object passed straight through to the vector store. Keys the handler actually " +
              "understands downstream: court, caseType, caseYear, judgeName, caseNumber, and decisionDate as an " +
              "object with $gte and or $lte sub keys for range filtering. Filters supplied here override whatever " +
              "filters the service would otherwise auto extract from the query text."
          ),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { query, page, limit, filters } = args as any;
      const body: Record<string, unknown> = { query };
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
        "optional metadata.diaryNumber, hasDocuments, documentCount and hasAnalysis. Text fields carry an " +
        "invisible watermark. Fields like detailedSummary, headnote, holding and keyFacts are NOT included here, " +
        "call get_case_analysis for those.",
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
        "constitutionalProvisions. Fields with no value are omitted from the response.",
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
        "Triggers AI analysis of a single case. CONSUMES AI CREDITS. ASYNCHRONOUS: normally returns immediately " +
        "with status processing while the analysis runs in the background; poll get_case_analysis after roughly " +
        "30 to 60 seconds to retrieve the result. If analysis already exists and force is not set, the existing " +
        "analysis is returned immediately instead with alreadyExists true. Set force true to re-analyze a case " +
        "that already has analysis, which also consumes credits again. Fails with a clear message if the case has " +
        "no usable text or PDF content to analyze.",
      inputSchema: {
        id: idParam,
        force: z.boolean().optional().describe("Re-run analysis even if it already exists, default false."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { id, force } = args as any;
      const body: Record<string, unknown> = {};
      if (force !== undefined) body.force = force;
      const result = await callApi(opts, {
        method: "POST",
        path: `cases/${encodeURIComponent(id)}/analyze`,
        body,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
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
        "credits are exhausted.",
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
      });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
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
        "the user or to a CourtMesh client that knows how to decrypt it. Returns 404 if the case has no stored " +
        "document.",
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
        "Kicks off a fetch of the live order and hearing history for a case directly from the court's own " +
        "systems. Asynchronous job, no AI credits consumed. case_id must be the 24 character MongoDB ObjectId " +
        "string, the id field from search results, a case number will fail. Supreme Court cases return " +
        "immediately with status completed and orderCount 0, since SC cases have no separate order history in " +
        "this system. District Court cases are fetched synchronously and come back completed or failed. High " +
        "Court cases usually return pending and must be polled with get_case_timeline using the returned " +
        "requestId.",
      inputSchema: {
        case_id: z
          .string()
          .min(1)
          .describe("24 character MongoDB ObjectId string for the case, from the id field of a search result. A case number will not work here."),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { case_id } = args as any;
      const result = await callApi(opts, {
        method: "POST",
        path: "request-timeline",
        body: { case_id },
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      if (!result.ok) return errorResult(result.message);
      return envelopeResult(result.data);
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
}

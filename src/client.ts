/**
 * HTTP client for the CourtMesh public REST API.
 *
 * Centralizes auth header handling and error mapping so every tool handler
 * gets consistent, LLM readable error messages instead of raw HTTP failures.
 */

export const DEFAULT_BASE_URL = "https://research.courtmesh.ai/api/v1/prod";

/** Reads a positive millisecond value from an env var, falling back when unset or invalid. */
function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Standard timeout for most endpoints. Overridable via COURTMESH_DEFAULT_TIMEOUT_MS, which exists
 * so tests can exercise the abort path against a deliberately slow mock without waiting the real
 * 120 seconds; production deployments should leave it unset.
 */
export const DEFAULT_TIMEOUT_MS = envMs("COURTMESH_DEFAULT_TIMEOUT_MS", 120_000);

/**
 * Longer timeout for semantic search and consolidated analysis, which can take minutes.
 * Overridable via COURTMESH_LONG_TIMEOUT_MS, same rationale as COURTMESH_DEFAULT_TIMEOUT_MS.
 * Deliberately 630s, not a round 600s: the server side semantic search handler
 * itself runs a 10 minute req.setTimeout, but analyze-consolidated and other
 * long calls are typically bounded well under 10 minutes, and a client timeout
 * exactly equal to a server timeout is a race either side can win. 630s gives
 * the server's own bounded work (up to ~600s in the slowest documented case)
 * a margin to time out and answer first.
 */
export const LONG_TIMEOUT_MS = envMs("COURTMESH_LONG_TIMEOUT_MS", 630_000);

/**
 * Timeout for request_case_timeline, which can trigger a synchronous live
 * fetch (refresh: true) against a court portal that is sometimes slow, but
 * should not need the full LONG_TIMEOUT_MS reserved for semantic search and
 * consolidated analysis. Overridable via COURTMESH_TIMELINE_TIMEOUT_MS.
 */
export const TIMELINE_TIMEOUT_MS = envMs("COURTMESH_TIMELINE_TIMEOUT_MS", 240_000);

/**
 * Key format: cm- or legacy vv- prefix, then 32 base64url chars, a dash, then 4 base64url chars.
 */
export const API_KEY_PATTERN = /^(?:cm|vv)-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{4}$/;

export interface ClientOptions {
  baseUrl: string;
  apiKey: string | undefined;
  /** Overrides apiKey for this call. Used to carry a per session ?token= value in HTTP mode. */
  apiKeyOverride?: string | undefined;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * Thrown by request() when the API call fails in any way (network, timeout,
 * non-2xx status, or a 200 response carrying success:false in its body).
 * The message is already formatted for direct display to an LLM caller.
 */
export class CourtMeshApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourtMeshApiError";
  }
}

function buildUrl(baseUrl: string, path: string, query?: RequestOptions["query"]): string {
  const url = new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

/**
 * Extra, code specific actionable guidance appended to an error message when the
 * API body carries a machine readable "code" this client recognises. Returns
 * undefined for a code with nothing more useful to add than the API's own
 * message/details, which is most of them.
 */
function codeGuidance(code: string | undefined): string | undefined {
  switch (code) {
    case "REMOTE_FETCH_NOT_ALLOWED":
      return (
        "If this case's document simply is not in stored data yet, retry analyze_case with " +
        "allowRemoteFetch: true. If it was refused for tier or host reasons instead, allowRemoteFetch will not help; " +
        "upgrade off the Free tier, or note that only ecourts.gov.in, nic.in, sci.gov.in, gov.in and courtmesh.ai " +
        "hosts can ever be fetched remotely."
      );
    case "LIVE_FETCH_NOT_ALLOWED":
      return (
        "This call needs a live fetch (refresh: true), which is not available on this tier. Drop refresh " +
        "to accept a stored-only result, or upgrade the plan for live fetch access."
      );
    case "SEMANTIC_NOT_ALLOWED":
      return "Semantic search is not available on this tier. Use search_indian_court_cases instead, or upgrade the plan.";
    case "DISTINCT_CASES_LIMIT_REACHED":
      return "This tier's daily cap on distinct case detail fetches has been reached. Wait for the daily reset, or upgrade for a higher cap.";
    case "TOO_MANY_KEYS_FROM_IP":
      return "Too many different API keys have been used from this network address today. Wait for the daily reset, or contact CourtMesh support if this is unexpected.";
    case "CURSOR_INVALID":
      return "Start the search again without a cursor rather than editing or reusing an old one.";
    default:
      return undefined;
  }
}

function describeValidationError(status: number, body: any): string {
  const code: string | undefined = typeof body?.code === "string" ? body.code : undefined;

  // CURSOR_INVALID has no "error" or "details" field either, only "code" and "message" - it
  // used to fall into the PAGE_LIMIT_EXCEEDED shaped branch below (which only checks for a
  // missing "error" field) and get misreported as a plan/tier page size problem.
  if (code === "CURSOR_INVALID") {
    const message: string = typeof body?.message === "string" ? body.message : "This pagination cursor is invalid or expired.";
    const guidance = codeGuidance(code);
    return `Request rejected (400): ${code}. ${message}${guidance ? ` ${guidance}` : ""}`;
  }

  // PAGE_LIMIT_EXCEEDED / PAGINATION_DEPTH_EXCEEDED (the per tier query-shape guard on
  // search/cases and search/cases/semantic) carry no "error" or "details" field, only "code",
  // "limit" and "tier". Falling back to the generic "Validation failed" text for this shape used
  // to suggest the request body was malformed, when the real problem is a plan limit.
  if (typeof body?.error !== "string" && typeof code === "string") {
    const limit = typeof body?.limit === "number" ? body.limit : "unknown";
    const tier = typeof body?.tier === "string" ? body.tier : "unknown";
    return (
      `Request rejected (400): ${code}. The requested page/limit shape (limit sent: ${limit}) ` +
      `exceeds what the "${tier}" plan tier allows. Reduce page or limit, or upgrade the plan.`
    );
  }
  const details: string[] = Array.isArray(body?.details) ? body.details : [];
  const baseMessage: string =
    typeof body?.error === "string" ? body.error : (typeof body?.message === "string" ? body.message : "Validation failed. Please check your request and try again.");
  const detailText = details.length > 0 ? `\nDetails:\n- ${details.join("\n- ")}` : "";
  return `Request rejected (400): ${baseMessage}${detailText}`;
}

function describeAuthError(body: any): string {
  const apiError: string | undefined = typeof body?.error === "string" ? body.error : undefined;
  const suffix = apiError ? ` The API said: "${apiError}".` : "";
  return (
    "Authentication failed (401). The CourtMesh API rejected the API key. " +
    "Set COURTMESH_API_KEY to a valid key (format cm-xxxx...), or pass ?token= in HTTP mode. " +
    `Get a key at https://research.courtmesh.ai.${suffix}`
  );
}

function describeForbiddenError(body: any): string {
  const apiError: string | undefined = typeof body?.error === "string" ? body.error : undefined;
  const parts: string[] = [];
  parts.push(`Access denied (403).${apiError ? ` The API said: "${apiError}".` : ""}`);
  if (typeof body?.code === "string") {
    parts.push(`Code: ${body.code}.`);
  }
  if (typeof body?.callsToday === "number" || typeof body?.maxAllowed === "number") {
    parts.push(`Calls today: ${body?.callsToday ?? "unknown"}. Max allowed: ${body?.maxAllowed ?? "unknown"}.`);
  }
  if (typeof body?.message === "string" && body.message !== apiError) {
    parts.push(body.message);
  }
  // Present on the free tier AI lockout (API_TIER_NOT_ALLOWED) shape, which has no "error" field
  // at all, only "message"/"code"/"upgradeUrl": this used to be silently dropped, leaving the
  // caller with no link to actually fix the problem.
  if (typeof body?.upgradeUrl === "string") {
    parts.push(`Upgrade at: ${body.upgradeUrl}.`);
  }
  const guidance = codeGuidance(typeof body?.code === "string" ? body.code : undefined);
  if (guidance) parts.push(guidance);
  parts.push("This is an account, plan, or quota gate, not a code error. Check the CourtMesh billing or plan settings.");
  return parts.join(" ");
}

function describePaymentRequiredError(body: any): string {
  const apiError: string | undefined = typeof body?.error === "string" ? body.error : undefined;
  const parts: string[] = [`Insufficient credits (402).${apiError ? ` The API said: "${apiError}".` : ""}`];
  // The API's field is "required", not "requiredCredits": this used to read the wrong key and
  // always print "unknown" even when the API supplied the real number.
  if (typeof body?.required === "number" || typeof body?.balance === "number" || typeof body?.shortfall === "number") {
    parts.push(
      `Required: ${body?.required ?? "unknown"}. Balance: ${body?.balance ?? "unknown"}. ` +
        `Shortfall: ${body?.shortfall ?? "unknown"}.`
    );
  }
  if (typeof body?.topUpUrl === "string") {
    parts.push(`Top up at: ${body.topUpUrl}.`);
  } else if (body?.contactAdmin === true) {
    parts.push("This is an org owned credit wallet and only an org admin can top it up; contact your admin.");
  }
  parts.push("Buy a credit pack or upgrade the plan, then retry.");
  return parts.join(" ");
}

function describeRateLimitError(body: any): string {
  const retryAfter = body?.retryAfter;
  const resetTime = body?.resetTime;
  const message: string | undefined = typeof body?.message === "string" ? body.message : undefined;
  const parts: string[] = ["Rate limited (429)."];
  if (retryAfter !== undefined) {
    parts.push(`Retry after ${retryAfter} seconds.`);
  }
  if (resetTime) {
    parts.push(`Rate limit resets at ${resetTime}.`);
  }
  if (message) {
    parts.push(message);
  }
  const guidance = codeGuidance(typeof body?.code === "string" ? body.code : undefined);
  if (guidance) parts.push(guidance);
  return parts.join(" ");
}

function describeNotFoundError(body: any): string {
  const apiError: string | undefined = typeof body?.error === "string" ? body.error : undefined;
  const parts: string[] = [`Not found (404).${apiError ? ` ${apiError}` : " The requested resource was not found."}`];
  // get_case_pdf_url's two distinct 404s (CASE_NOT_FOUND vs PDF_NOT_STORED, the latter with a
  // hint pointing at request_case_timeline) used to be indistinguishable here: only body.error
  // was ever surfaced, so both looked like the same plain "not found" to the calling model.
  if (typeof body?.code === "string") {
    parts.push(`Code: ${body.code}.`);
  }
  if (typeof body?.hint === "string") {
    parts.push(body.hint);
  }
  return parts.join(" ");
}

function describeGenericError(status: number, body: any): string {
  const apiError: string | undefined = typeof body?.error === "string" ? body.error : undefined;
  return `CourtMesh API returned status ${status}.${apiError ? ` Error: ${apiError}` : ""}`;
}

/**
 * Turn an HTTP status plus a parsed JSON body into a readable error string,
 * or return null if the response should be treated as success.
 */
function classifyError(status: number, body: any): string | null {
  if (status === 401) return describeAuthError(body);
  if (status === 402) return describePaymentRequiredError(body);
  if (status === 403) return describeForbiddenError(body);
  if (status === 429) return describeRateLimitError(body);
  if (status === 400) return describeValidationError(status, body);
  if (status === 404) return describeNotFoundError(body);
  if (status === 408 || status === 502 || status === 503 || status === 500) {
    return describeGenericError(status, body);
  }
  if (status >= 400) return describeGenericError(status, body);

  // Status looked fine (2xx), but a body can still carry success:false
  // (defensive: no endpoint is documented to do this today, but a 200
  // response is not proof the call actually succeeded, only that the HTTP
  // layer accepted it).
  if (body && typeof body === "object" && body.success === false) {
    const apiError: string | undefined = typeof body.error === "string" ? body.error : undefined;
    return `CourtMesh API reported failure despite HTTP ${status}.${apiError ? ` Error: ${apiError}` : ""}`;
  }

  return null;
}

/** Longest this client will ever sleep before its one bounded retry, regardless of what a
 *  Retry-After header or retryAfter body field asks for. */
const MAX_RETRY_DELAY_MS = 60_000;

interface RawAttempt {
  status: number;
  parsed: any;
  jsonParseFailed: boolean;
  retryAfterHeader: string | null;
}

/**
 * Performs one CourtMesh API call. Throws CourtMeshApiError with an LLM
 * readable message on any failure: network error, timeout, non 2xx status,
 * or a 200 response whose body has success:false.
 *
 * Idempotent GET requests get exactly one bounded retry when the failure is a
 * RATE_LIMITED 429: a per minute cap is usually gone a few seconds later, and
 * retrying a plain read has no side effects. POST is never retried here (a
 * screen, an analyze call, a search that bills or debits a monthly cap must
 * not be silently replayed by this client), and no other status or code is
 * ever retried.
 */
export async function request<T = any>(options: ClientOptions & RequestOptions): Promise<T> {
  const { baseUrl, apiKey, apiKeyOverride, method = "GET", path, query, body, timeoutMs } = options;
  const effectiveKey = apiKeyOverride ?? apiKey;
  const url = buildUrl(baseUrl, path, query);
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const attempt = async (): Promise<RawAttempt> => {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (effectiveKey) {
      headers["X-API-Key"] = effectiveKey;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === "AbortError") {
        throw new CourtMeshApiError(
          `Request to CourtMesh API timed out after ${Math.round(timeout / 1000)} seconds (${method} ${path}). ` +
            "The API may be slow or unreachable right now. Try again, or narrow the request."
        );
      }
      throw new CourtMeshApiError(
        `Network error while calling the CourtMesh API (${method} ${path}): ${err?.message ?? String(err)}. ` +
          "Check connectivity and that COURTMESH_API_BASE_URL is correct."
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: any = undefined;
    let jsonParseFailed = false;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non JSON body, fall through with parsed left undefined.
        jsonParseFailed = true;
      }
    }

    return { status: response.status, parsed, jsonParseFailed, retryAfterHeader: response.headers.get("retry-after") };
  };

  let result = await attempt();

  if (
    method === "GET" &&
    result.status === 429 &&
    !result.jsonParseFailed &&
    result.parsed?.code === "RATE_LIMITED"
  ) {
    const headerSeconds = Number(result.retryAfterHeader);
    const bodySeconds = Number(result.parsed?.retryAfter);
    const retryAfterSeconds =
      Number.isFinite(headerSeconds) && headerSeconds > 0
        ? headerSeconds
        : Number.isFinite(bodySeconds) && bodySeconds > 0
          ? bodySeconds
          : 1;
    const delayMs = Math.min(retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await attempt();
  }

  const { status, parsed, jsonParseFailed } = result;

  const errorMessage = classifyError(status, parsed);
  if (errorMessage) {
    // Forward compatible: no endpoint documents a requestId in its error body today, but
    // once one does (a concurrent workstream is adding X-Request-Id/request tracing), a
    // caller reporting a problem to CourtMesh support needs this printed, not silently
    // dropped because this client was written before the field existed.
    const requestId = typeof parsed?.requestId === "string" && parsed.requestId.length > 0 ? parsed.requestId : undefined;
    throw new CourtMeshApiError(requestId ? `${errorMessage} Request id: ${requestId}.` : errorMessage);
  }

  if (status < 200 || status >= 300) {
    throw new CourtMeshApiError(
      `CourtMesh API returned an unexpected status ${status} for ${method} ${path}.`
    );
  }

  // A non-error status with a body that failed to parse used to fall through silently and return
  // undefined as if the call had succeeded with no data, which then produced a tool result whose
  // text was not a string. A response the API itself marks as OK but that is not valid JSON is not
  // trustworthy enough to hand back as success.
  if (jsonParseFailed) {
    throw new CourtMeshApiError(
      `CourtMesh API returned status ${status} for ${method} ${path} with a body that was not valid JSON. ` +
        "This is an unexpected upstream response, not a problem with your request. Try again shortly."
    );
  }

  return parsed as T;
}

export function isValidApiKeyFormat(key: string): boolean {
  return API_KEY_PATTERN.test(key);
}

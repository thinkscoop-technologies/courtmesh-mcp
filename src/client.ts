/**
 * HTTP client for the CourtMesh public REST API.
 *
 * Centralizes auth header handling and error mapping so every tool handler
 * gets consistent, LLM readable error messages instead of raw HTTP failures.
 */

export const DEFAULT_BASE_URL = "https://research.courtmesh.ai/api/v1/prod";

/** Standard timeout for most endpoints. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Longer timeout for semantic search and consolidated analysis, which can take minutes. */
export const LONG_TIMEOUT_MS = 600_000;

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

function describeValidationError(status: number, body: any): string {
  const details: string[] = Array.isArray(body?.details) ? body.details : [];
  const baseMessage: string =
    typeof body?.error === "string" ? body.error : "Validation failed. Please check your request and try again.";
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
  if (typeof body?.callsToday === "number" || typeof body?.maxAllowed === "number") {
    parts.push(`Calls today: ${body?.callsToday ?? "unknown"}. Max allowed: ${body?.maxAllowed ?? "unknown"}.`);
  }
  if (typeof body?.message === "string" && body.message !== apiError) {
    parts.push(body.message);
  }
  parts.push("This is an account, plan, or quota gate, not a code error. Check the CourtMesh billing or plan settings.");
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
  return parts.join(" ");
}

function describeNotFoundError(body: any): string {
  const apiError: string | undefined = typeof body?.error === "string" ? body.error : undefined;
  return `Not found (404).${apiError ? ` ${apiError}` : " The requested resource was not found."}`;
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
  if (status === 403) return describeForbiddenError(body);
  if (status === 429) return describeRateLimitError(body);
  if (status === 400) return describeValidationError(status, body);
  if (status === 404) return describeNotFoundError(body);
  if (status === 408 || status === 502 || status === 503 || status === 500) {
    return describeGenericError(status, body);
  }
  if (status >= 400) return describeGenericError(status, body);

  // Status looked fine (2xx), but some CourtMesh endpoints (notably the
  // semantic search endpoint) flush a 200 status before doing the real work,
  // so a logical failure still needs to be detected from the body itself.
  if (body && typeof body === "object" && body.success === false) {
    const apiError: string | undefined = typeof body.error === "string" ? body.error : undefined;
    return `CourtMesh API reported failure despite HTTP ${status}.${apiError ? ` Error: ${apiError}` : ""}`;
  }

  return null;
}

/**
 * Performs one CourtMesh API call. Throws CourtMeshApiError with an LLM
 * readable message on any failure: network error, timeout, non 2xx status,
 * or a 200 response whose body has success:false.
 */
export async function request<T = any>(options: ClientOptions & RequestOptions): Promise<T> {
  const { baseUrl, apiKey, apiKeyOverride, method = "GET", path, query, body, timeoutMs } = options;
  const effectiveKey = apiKeyOverride ?? apiKey;
  const url = buildUrl(baseUrl, path, query);

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
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non JSON body, fall through with parsed left undefined.
    }
  }

  const errorMessage = classifyError(response.status, parsed);
  if (errorMessage) {
    throw new CourtMeshApiError(errorMessage);
  }

  if (!response.ok) {
    throw new CourtMeshApiError(
      `CourtMesh API returned an unexpected status ${response.status} for ${method} ${path}.`
    );
  }

  return parsed as T;
}

export function isValidApiKeyFormat(key: string): boolean {
  return API_KEY_PATTERN.test(key);
}

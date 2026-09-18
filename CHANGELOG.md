# Changelog

All notable changes to `@courtmesh/mcp-server` are documented here.

## 0.4.1

Three fixes from a live authenticated QA pass against the hosted server
(`QA_LIVE_MCP_AUTH_2026-09-19.md`), all in the shared client/tool plumbing
rather than any single endpoint.

### Fixed

- `client.ts`'s `describeGenericError` (the 500/502/503/408 error path) used
  to surface only `body.error`, dropping `body.code` and `body.message` even
  when the API sent them - unlike `describeForbiddenError` and
  `describeNotFoundError`, which already surfaced `code`. A `get_court_coverage`
  503 with `code: "COVERAGE_NOT_READY"` now reads `CourtMesh API returned
  status 503. Code: COVERAGE_NOT_READY. Error: ...`, and any other 5xx/408
  carrying a machine readable `code` is handled the same way.
- `analyze_case`, `analyze_consolidated_case`, `request_case_timeline`,
  `screen_party_litigation` and `screen_party_litigation_batch` now surface an
  explicit replay signal. `client.ts`'s `request()` reads the
  `Idempotency-Replayed` response header and sets `replayed: true/false` on
  the parsed body; when true, the tool result text now starts with the line
  `Replayed: identical request served from the 24 hour idempotency cache, no
  credits charged.`, before this the only (undocumented) tell was
  `screen_party_litigation`'s `query.name`/`query.aliases` coming back as
  redaction placeholders instead of their literal values.
- `search_indian_court_cases`: the live `/search/cases` index returns
  `mongoId` on each hit, not `id`, even though every other tool here
  (`get_case`, `find_related_cases`, `get_case_pdf_url`, and especially
  `request_case_timeline`) documents passing in "the id field from search
  results". Hits missing `id` now get it backfilled from `mongoId`
  (`backfillSearchHitIds` in `src/tools.ts`); `mongoId` is left in place
  alongside it, and a hit that already has its own `id` is untouched, so this
  keeps working once the server starts adding `id` itself.
- `test/e2e/mock-api.mjs`: `scenario503Body` now carries `code:
  "COVERAGE_NOT_READY"` (matching the real API body confirmed via raw REST in
  the QA report), `/search/cases` hits now carry `mongoId` instead of `id`
  (matching the real index), and a new `Idempotency-Key` replay simulation
  (an in-memory `idempotencyStore` plus a `captureResponse` helper) replays
  the first stored 2xx response with `Idempotency-Replayed: true` for a
  repeated key, so the replay path is actually exercised end to end.

## 0.4.0

Adds 4 new tools (18 total) for the research server's account-introspection,
public reference and party-screen-batch endpoints, plus the `Idempotency-Key`
contract being rolled out across the job/charge-triggering POST endpoints.

### Added

- `get_api_usage`: `GET /usage`, this key's tier, wallet balance, per period
  limits and per endpoint call volume for the current Asia/Kolkata calendar
  month. No arguments. Unmetered.
- `list_reference_courts`: `GET /reference/courts`, the court taxonomy
  accepted by `court` filters elsewhere in this API. No arguments, no API
  key required.
- `list_reference_case_types`: `GET /reference/case-types`, every `caseType`
  value accepted elsewhere in this API. No arguments, no API key required.
- `screen_party_litigation_batch`: `POST /party/screen/batch`, screens 1 to
  25 names in one call, the same DPDP-guided litigation check as
  `screen_party_litigation` run once per item; each item independently
  priced and independently able to fail (`ok`/`error` per result entry)
  without failing the rest of the batch. Not available on the Free tier. No
  `adjudicate` option in this batch form.
- `analyze_case`, `analyze_consolidated_case`, `request_case_timeline`,
  `screen_party_litigation` and `screen_party_litigation_batch` now send an
  `Idempotency-Key` header automatically: a SHA-256 hash of the tool name
  plus its exact arguments (`computeIdempotencyKey` in `src/tools.ts`, with
  a stable, recursively key-sorted JSON serialization so argument order
  never changes the hash). A model that retries one of these calls with
  identical arguments is recognised server side as a replay and gets the
  stored response back instead of a second charge or a second job run.
  Documented in each affected tool's description; no new argument or
  configuration needed.
- Every error message now falls back to the `X-Request-Id` response header
  when the error body itself carries no `requestId` field, so a caller
  reporting a problem to CourtMesh support always has a request id to
  quote.
- `test/e2e/mock-api.mjs`: added `GET /usage`, `GET /reference/courts`,
  `GET /reference/case-types` and `POST /party/screen/batch` routes; the two
  reference routes need no API key, matching the real API.

## 0.3.0

Aligned the server with the current CourtMesh public API contract (`api-v1-validations.ts`,
`api-v1-prod.ts`, `party-screen-service.ts`, `api-tiers.ts`, `rate-limiter.ts`) and closed several
stale or incomplete tool descriptions.

### Added

- `search_indian_court_cases`: new `cursor` input, the opaque signed pagination cursor. Documented
  it as the current mechanism, with the raw `searchAfter` array kept only for callers on a server
  with the self serve API tiers feature off. `limit` now documents the Free tier's 20 result page
  size cap and the `PAGE_LIMIT_EXCEEDED` / `PAGINATION_DEPTH_EXCEEDED` 400 codes.
- `semantic_search_cases`: exposed the real top level filters the API accepts (`court`, `year`,
  `caseType`, `judgeName` and its aliases `judges`/`judge` as a single value, `caseNumber` as
  digits only, `fromDate`, `toDate`), mapped onto the vector store's filter keys and echoed back in
  `meta.appliedFilters`, alongside the existing nested `filters` object.
- `request_case_timeline`: new `refresh` boolean input. Default false is a stored read (1 credit,
  `meta.liveFetch: false`); `refresh: true` forces a live court fetch (20 credits, PAYG tier or
  above, HTTP 403 `LIVE_FETCH_NOT_ALLOWED` on Free, HTTP 429 `LIVE_FETCH_LIMIT_REACHED` once the
  tier's daily cap is exhausted). Timeout raised to 240 seconds for the live path.
- `analyze_case`: new `allowRemoteFetch` boolean input. Required before the server will fetch a
  case's source document from a remote court host; without it, a case needing a remote fetch
  returns HTTP 403 `REMOTE_FETCH_NOT_ALLOWED`. Adds a 20 credit surcharge on top of the base 100
  when a remote fetch actually happens.
- `get_case_pdf_url`: documented the two distinct 404s, `CASE_NOT_FOUND` (no such case) versus
  `PDF_NOT_STORED` (case exists, no stored document, with a `hint` pointing at
  `request_case_timeline` with `refresh: true`).
- `client.ts`: a single bounded retry for idempotent GET calls that fail with a `RATE_LIMITED` 429,
  honouring the response's `Retry-After` header (or the body's `retryAfter`), capped at 60 seconds.
  POST is never retried. Error messages now surface `requestId` from an error body when present.
  Per code guidance text added for `REMOTE_FETCH_NOT_ALLOWED`, `LIVE_FETCH_NOT_ALLOWED`,
  `SEMANTIC_NOT_ALLOWED`, `DISTINCT_CASES_LIMIT_REACHED`, `TOO_MANY_KEYS_FROM_IP`,
  `CURSOR_INVALID`, `PAGE_LIMIT_EXCEEDED` and `PAGINATION_DEPTH_EXCEEDED`.

### Changed

- `screen_party_litigation`: `limit` now caps at 100 (`.max(100)`), `displayThreshold` is bounded
  to `.min(0).max(1)`, `knownPersons` caps at 10 entries, and `court` accepts a single court name
  string or a one element array (a second court is rejected with a 400 instead of silently used).
  Description rewritten to state that Free tier `adjudicate: true` is a hard HTTP 403
  `API_TIER_NOT_ALLOWED` block, not a silent no-op; that the response's top level `notice` field
  (there is no `coverage.note`) carries the case removal policy text; the full verdict rules
  (`since` always forces `inconclusive`; a withheld record with nothing else surviving forces
  `inconclusive`; `matchCount` can read 0 while `verdict` still reads `matches_found` when
  `displayThreshold` hides everything); and that the 80 credit adjudicate surcharge is billed only
  when `adjudicationsRun > 0`. Also notes the Free tier has no `semantic_search_cases` access
  (403 `SEMANTIC_NOT_ALLOWED`) and no live timeline fetches.
- `client.ts`: `LONG_TIMEOUT_MS` default raised from 600s to 630s, so the client's own timeout does
  not race the server's slowest documented internal deadline. Fixed `CURSOR_INVALID` (a 400 body
  with no `error` field) being misreported as the unrelated tier page size cap shape.

### Removed

- Deleted stale caveats that no longer match the server: `semantic_search_cases` no longer claims
  its top level filter fields are silently ignored (they are now real filters, see Added above),
  and the README no longer describes `POST /search/cases/semantic` as flushing an HTTP 200 before
  finishing work (that early-flush behaviour was removed server side; a failure now arrives with
  its real status code).

## 0.2.0 and earlier

See git history.

# @courtmesh/mcp-server

An MCP (Model Context Protocol) server for the CourtMesh public REST API. It gives any MCP capable AI client, Cursor, or a custom agent, tools to search and analyze Indian court case law, screen a party name for litigation history, and check court coverage. Keyword search across Indian court records.

Built with the official `@modelcontextprotocol/sdk`. MIT licensed.

## Quickstart

### 1. Get an API key

Sign up and generate a key at [https://research.courtmesh.ai](https://research.courtmesh.ai). Keys look like `cm-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-xxxx` (a legacy `vv-` prefix also works).

### 2. Run it

You do not need to install anything by hand, `npx` will fetch and run the package. Set `COURTMESH_API_KEY` in your MCP client config, see the copy pasteable blocks below.

Local checkout:

```bash
npm install
npm run build
COURTMESH_API_KEY=cm-your-key-here node dist/index.js
```

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `COURTMESH_API_KEY` | Recommended | none | Your CourtMesh API key. Tools list fine without it, but any real API call will fail with a 401 style error until it is set. In HTTP mode a per session `?token=` query parameter overrides this. |
| `COURTMESH_API_BASE_URL` | No | `https://research.courtmesh.ai/api/v1/prod` | Override to point at a different CourtMesh environment. |
| `MCP_TRANSPORT` | No | `stdio` | Set to `http` to run the Streamable HTTP transport instead of stdio. Equivalent to passing `--http`. |
| `PORT` | No | `3000` | Port for the HTTP transport. |
| `COURTMESH_DEFAULT_TIMEOUT_MS` | No | `120000` | Timeout for most tool calls. |
| `COURTMESH_TIMELINE_TIMEOUT_MS` | No | `240000` | Timeout for `request_case_timeline`, which can trigger a live court fetch. |
| `COURTMESH_LONG_TIMEOUT_MS` | No | `630000` | Timeout for `semantic_search_cases` and `analyze_consolidated_case`, which can take minutes. |

## Transports

This server supports two transports, chosen at startup:

- **stdio** (default): the standard transport for local MCP clients such as Cursor and other desktop and command line MCP clients. The client spawns the server process and talks to it over stdin and stdout.
- **Streamable HTTP**: pass `--http` or set `MCP_TRANSPORT=http` to run as a long lived HTTP server, mounted at `/mcp`, suitable for hosting behind a URL such as `mcp.courtmesh.ai/mcp`. A plain `GET /health` route is also available on the HTTP server itself, separate from the `check_api_health` tool, which checks the upstream CourtMesh API instead.

## Tools

| Tool | Endpoint | Credits | One line |
| --- | --- | --- | --- |
| `search_indian_court_cases` | `POST /search/cases` | No | Fast keyword and boolean search across Indian court records. |
| `semantic_search_cases` | `POST /search/cases/semantic` | Yes | AI search for natural language questions about legal concepts. |
| `get_case` | `GET /cases/{id}` | No | Full case details, without AI analysis. |
| `get_case_analysis` | `GET /cases/{id}/analysis` | Yes | Reads any existing AI analysis for a case, read only. 1 credit per read; the first read of a case by your organization costs the credits generating that analysis used. |
| `find_related_cases` | `GET /cases/{id}/related` | No | Other documents sharing the same case number, plus a procedural timeline. |
| `search_judges` | `GET /judges/search` | No | Autocomplete over Supreme Court and High Court judge names. |
| `analyze_case` | `POST /cases/{id}/analyze` | Yes | Triggers AI analysis of one case, asynchronous. `allowRemoteFetch: true` permits fetching the source document from a remote court host, at a 20 credit surcharge. |
| `analyze_consolidated_case` | `POST /cases/{id}/analyze-consolidated` | Yes, more | AI analysis merged across every document sharing a case number, synchronous and slow. |
| `get_case_pdf_url` | `GET /cases/{id}/pdf` | No | A time limited, encrypted link to the official judgment PDF. |
| `request_case_timeline` | `POST /request-timeline` | No, unless `refresh: true` | Reads stored order and hearing history by default (1 credit); `refresh: true` forces a live fetch from the court's own systems (also 1 credit, PAYG tier or above). |
| `get_case_timeline` | `GET /get-timeline/{requestId}` | No | Polls the job started by `request_case_timeline`. |
| `screen_party_litigation` | `POST /party/screen` | Yes | Litigation check for a person or company name: KYC, BGV, due diligence, and litigation/compliance screening. |
| `get_court_coverage` | `GET /coverage` | No | Corpus coverage and freshness snapshot, no authentication required. |
| `check_api_health` | `GET /health` | No | Checks CourtMesh API connectivity, no authentication required. |
| `get_api_usage` | `GET /usage` | No | This key's tier, wallet balance, per period limits and per endpoint call volume for the current month. |
| `list_reference_courts` | `GET /reference/courts` | No | The court taxonomy accepted by `court` filters elsewhere, no authentication required. |
| `list_reference_case_types` | `GET /reference/case-types` | No | Every `caseType` value accepted elsewhere, no authentication required. |
| `screen_party_litigation_batch` | `POST /party/screen/batch` | Yes | Screens up to 25 names in one call, same check as `screen_party_litigation`; each item independently priced and independently able to fail. Not available on the Free tier, no adjudicate option. |
| `build_party_profile` | `POST /party/profile` | At least 100 credits per profile | A litigation profile of one person or company: cases grouped into identities by shared evidence, with status, acts and FIR as the court record states them, documents and a summary. `mode` is required. `quick` answers at once and costs at least 100 and never more than 304 credits. `full` runs in the background, reads each case of the first identity again from its court and analyses it, and is charged as each stage finishes, up to `maxCredits` (100 to 5000, default 1000). Not available on the Free tier. |
| `get_party_profile` | `GET /party/profile/{requestId}` | No | Where a full mode profile stands, with its credits so far, and the profile once it is complete. |
| `lookup_case_by_cnr` | `GET /cases/by-cnr/{cnr}` | 1 credit when a record is returned | Finds one case from its 16 character CNR. `fetch: true` starts a live court fetch for a CNR not in our records yet: the starting call returns `pending` and is free, the call that returns the record is the 1 credit charge, and the fetch shares the daily live fetch cap. Call again with the same CNR to poll. If the court had nothing for the CNR in the last 24 hours it is not asked again and the call is a 404. |
| `create_watchlist` | `POST /watchlists` | No | Creates a watchlist and optionally starts watching up to 100 CNRs. Daily monitoring is included in your plan, within the watched case cap. |
| `list_watchlists` | `GET /watchlists` | No | Lists the account's watchlists. |
| `add_cases_to_watchlist` | `POST /watchlists/{id}/items` | No | Starts watching 1 to 100 CNRs, with a per case result (watching, pending, invalid, duplicate, cap_exceeded, not_found). `cap_exceeded` covers the watched case cap, a daily add allowance (Free 50, Pay As You Go 5,000, Scale 50,000, Enterprise 500,000) and the daily limit on CNRs we do not hold yet. |
| `remove_case_from_watchlist` | `DELETE /watchlists/{id}/items/{cnr}` | No | Stops watching one CNR (404 `ITEM_NOT_FOUND` if it is not on the list). |
| `list_watchlist_cases` | `GET /watchlists/{id}/items` | No | The cases on a watchlist with their current snapshot (status, stage, next hearing date, order count). A case taken down at a party's request shows as `unavailable` with its case fields null. |
| `get_case_changes` | `GET /changes`, `GET /watchlists/{id}/events` | 1 credit per non-empty page | The change feed: new orders, hearing date, status, stage and disposal changes. An empty page is free, so polling is cheap. |
| `resolve_act` | `GET /acts/resolve` | 1 credit when something is returned | Turns a short form or name (IPC, NI Act, Cr.P.C.) into up to five candidate acts, best first. |
| `search_acts` | `GET /acts/search` | 1 credit when something is returned | Finds acts, rules and regulations by title, short form or subject, with filters for kind, jurisdiction and year. |
| `get_act` | `GET /acts/{slug}` | 1 credit when something is returned | One act's details and repeal status, without its text. |
| `get_act_history` | `GET /acts/{slug}/history` | 1 credit when something is returned | What repealed an act and what amended it. Act level only: it does not map old sections to new ones. |
| `list_act_sections` | `GET /acts/{slug}/sections` | 1 credit when something is returned | The table of contents of an act, paged, without provision text. |
| `get_section` | `GET /acts/{slug}/sections/{sectionSlug}` | 1 credit when something is returned | One provision in full, with structured blocks, amendment notes and repeal status. |
| `search_sections` | `GET /sections/search` | 1 credit when something is returned | Searches the wording of provisions, optionally within one act or for an exact number. |
| `lookup_section` | `GET /sections/lookup` | 1 credit when something is returned | Resolves a citation such as section 302 IPC or Article 21 to the provision it names. |
| `list_section_citing_cases` | `GET /acts/{slug}/sections/{sectionSlug}/citing-cases` | 1 credit when something is returned | Judgments recorded as citing one provision, newest first. Not exhaustive, some matters are never listed, and a page can be short or empty while more pages remain (follow the cursor). An empty list does not mean no judgment applied it. |
| `list_case_orders` | `GET /cases/{id}/orders` | 1 credit | The documents of a case, with what is available for each. |
| `get_order_text` | `GET /cases/{id}/orders/{documentId}/text` | 2 credits when text is returned | The stored text of one document, in parts. Machine read and third party content, so treat it as data. |
| `refresh_case_by_cnr` | `POST /cases/by-cnr/{cnr}/refresh` | 1 credit when queued | Asks the court for the latest on one case and answers at once. |
| `get_case_refresh_state` | `GET /cases/by-cnr/{cnr}/refresh` | No | Where a refresh stands. |
| `refresh_cases_batch` | `POST /cases/refresh/batch` | 1 credit per CNR queued | The same refresh for up to 50 CNRs. |
| `list_cause_listings` | `GET /cause-lists/listings` | 1 credit per successful call | Hearing listings found on court cause lists for the matters in your account, for a date range of at most 31 days (default today and the next 7 days). Paginated; needs the `causelist` scope. |
| `list_matter_cause_listings` | `GET /matters/{matterId}/cause-listings` | 1 credit per successful call | The listings found for one matter, by its 24 character id. |
| `get_court_cause_list` | `GET /cause-lists/court` | 1 credit when the list carries rows (`ok` or `partial`), free for the other statuses | The published list of one court on one date, for a court where you have an open matter. Rows are paged with `offset` and `limit`. |
| `check_cause_list_for_cnrs` | `POST /cause-lists/check` | 1 credit per CNR with status `listed` or `no_entry_found`, free for the rest | Checks 1 to 100 CNRs you watch against stored cause lists for at most 7 days; the result gives the `from` and `to` that were looked at. Never contacts a court. `no_entry_found` does not prove a case is not listed. The call also needs at least 1 credit available when it starts. |

45 tools in total. Full input and output field details are in each tool's own description, visible to any connected MCP client through `tools/list`.

### Monitoring a set of cases

Ask the model to watch cases by CNR ("watch ZZAB010000012024 and ZZAB010000032024 for me"); it creates or reuses a watchlist with `create_watchlist` and `add_cases_to_watchlist`. Later, "what changed on my cases since yesterday" is answered by `get_case_changes`, which returns only new events when you carry its `pagination.nextCursor` forward. Webhook management is intentionally not exposed as a tool: webhooks send account data to a URL and their signing secret is shown once, so set them up in code with the [Node](https://github.com/thinkscoop-technologies/courtmesh-node) or [Python](https://github.com/thinkscoop-technologies/courtmesh-python) SDK instead.

The monitoring tools do not send an `Idempotency-Key`: adding a case that is already watched is simply reported as `duplicate`, so a retry is safe without one.

### Cause lists

The four cause list tools need an API key with the `causelist` scope and an account with cause lists enabled. They report only listings that were found. An empty result, a `no_entry_found` status or a missing row is never a statement that a case is not listed, and the tool results say so to the model. Text read from court lists (case text, party names, headings) is marked `_meta.provenance.untrusted_content` and the descriptions tell the model to treat it as data. The tools are annotated read only, and cancelling a call stops the request to the API.

`check_cause_list_for_cnrs` also sends an `Idempotency-Key`, but unlike the six tools in the Idempotency section below its replay is short lived and its result does not start with that "24 hour" line; the key also carries a 5 minute time bucket and the default dates (today and tomorrow, resolved in India time), so an identical retry within the same 5 minute window replays the stored result without a new charge, while a call in a later bucket or on a new day reads the lists again. A replayed result says so, names the dates it covers and that it may be out of date; pass `fresh: true` to read the lists again. Limits: 1 to 100 CNRs, and distinct CNRs (repeats are ignored) times dates in the range (inclusive; 2 by default) at most 300, checked before any request. A 402 can also arrive after the answer is ready, when the credits due cannot be settled, with no results returned; a 503 `SETTLEMENT_UNCONFIRMED` means the answer was ready but the charge outcome is unknown and no results were returned: do not retry, check `get_api_usage` first (repeating the same call is refused with 409 `IDEMPOTENCY_IN_PROGRESS` for up to 24 hours; changed arguments or `fresh: true` is a new request). A 503 `ENTITLEMENT_UNAVAILABLE` ran nothing and is safe to retry. `status` values: `listed`, `no_entry_found` (does not prove a case is not listed), `list_not_read` (for a District Court it can also mean the list of the case's own courtroom could not be confirmed, and then `dates[].status` is `none`), `cannot_check` (`reason` is `pending`, `record_unavailable`, `court_not_supported`, `no_case_identity`, `no_court_key`, `no_court_number`, `invalid_court_key` or `unsupported_court`) and `not_watched`. The four tools are annotated read only but not idempotent, because each call is charged. A 502 `UPSTREAM_UNAVAILABLE` is not charged and the model is told to wait and try once more. `get_court_cause_list` serves later pages of a list it already read (same `court_key` and `date`) from memory for 5 minutes (those pages report `meta.creditsCharged` 0 and `meta.servedFromSession`, and the result says how long the stored list stays available), so paging a long list is charged once.

### Party profile

`build_party_profile` makes `mode` a required argument, so the model always chooses between a quick answer and a background run, and its description tells the model to say the mode and the most it may cost before calling. It sends an `Idempotency-Key` in the same way as `screen_party_litigation`: an identical retry in the same session within 24 hours replays the stored answer without a new charge, and in full mode replays the same `requestId` instead of starting a second run. Results that carry a profile (party names, case titles, reasons and analyses from court records) are marked `_meta.provenance.untrusted_content` and the descriptions tell the model to treat that text as data. A profile too large to return whole is compacted step by step (document lists, then the case facts of other possible identities, then other rows of the same matter, then cases past a count), and the result says what was left out and how to read it; nothing is cut silently. `get_party_profile` is free and read only. The completion `webhook` of full mode is not exposed as an argument, for the same reason webhook management is not (see Monitoring above).

`DELETE /audit` (removing an API key's activity history) is available in the [Node](https://github.com/thinkscoop-technologies/courtmesh-node) and [Python](https://github.com/thinkscoop-technologies/courtmesh-python) SDKs only. It is deliberately not a tool: it erases account records, so it should be a deliberate call made by a person, not something a model can do in a conversation.

### Idempotency

`analyze_case`, `analyze_consolidated_case`, `request_case_timeline`, `screen_party_litigation`, `screen_party_litigation_batch` and `build_party_profile` each send an `Idempotency-Key` header automatically, derived as a SHA-256 hash of the tool name plus its exact arguments (see `computeIdempotencyKey` in `src/tools.ts`). If a model retries one of these calls with identical arguments, whether because of its own retry logic, a dropped connection, or a re-sent turn, the server recognises the replay (same key, same body) and returns the stored response again instead of re-running the job or re-charging credits. Changing even one argument produces a different key and runs as a brand new, separately charged call. This requires no configuration and needs no argument from the calling model.

When a call is served from that cache, the server answers with an `Idempotency-Replayed: true` header; `client.ts` turns that into a `replayed: true` field on the parsed response, and the tool result text for all six of these tools starts with a `Replayed: identical request served from the 24 hour idempotency cache, no credits charged.` line, so the calling model (and anyone reading a transcript) has a positive, explicit signal instead of having to notice on its own that, for example, `screen_party_litigation` redacted `query.name`/`query.aliases` on that response.

## Configuration examples

### Any stdio MCP client

Add this to your client's MCP server configuration (the file name and location vary by client; most use an `mcpServers` object):

```json
{
  "mcpServers": {
    "courtmesh": {
      "command": "npx",
      "args": ["-y", "@courtmesh/mcp-server"],
      "env": {
        "COURTMESH_API_KEY": "cm-your-key-here"
      }
    }
  }
}
```

### Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "courtmesh": {
      "command": "npx",
      "args": ["-y", "@courtmesh/mcp-server"],
      "env": {
        "COURTMESH_API_KEY": "cm-your-key-here"
      }
    }
  }
}
```

### Hosted HTTP mode

`https://mcp.courtmesh.ai/mcp` is live: point any Streamable HTTP capable MCP client at it directly, no local process required. Send your key either as an `Authorization: Bearer` header (preferred) or as a `?token=` query parameter, for clients that can only configure a URL; either form overrides `COURTMESH_API_KEY` for that session.

Header form:

```json
{
  "mcpServers": {
    "courtmesh": {
      "url": "https://mcp.courtmesh.ai/mcp",
      "headers": {
        "Authorization": "Bearer cm-your-key-here"
      }
    }
  }
}
```

Query parameter form, for a client that cannot set headers:

```json
{
  "mcpServers": {
    "courtmesh": {
      "url": "https://mcp.courtmesh.ai/mcp?token=cm-your-key-here"
    }
  }
}
```

## Error codes

The API's own error text is always surfaced verbatim where available, along with a plain explanation.

| Status | Meaning | What to do |
| --- | --- | --- |
| 401 | The API key is missing, malformed, invalid, or deactivated. | Set `COURTMESH_API_KEY` to a valid key, or fix the `?token=` value in HTTP mode. Get a key at https://research.courtmesh.ai. |
| 402 | Insufficient credits for the endpoint's price, on any priced call (`analyze_case`, `analyze_consolidated_case`, `semantic_search_cases`, `screen_party_litigation`, a live `request_case_timeline` refresh). The response includes `required`, `balance` and `shortfall`. | Buy a credit pack or upgrade the plan, then retry. |
| 403 | Account, plan, or quota gate, distinguished by a machine readable `code`: `API_TIER_NOT_ALLOWED` (a Free tier account calling `analyze_case`, `analyze_consolidated_case`, `get_case_analysis`, or `adjudicate: true` on `screen_party_litigation`, none of which the Free tier may use), `SEMANTIC_NOT_ALLOWED` (`semantic_search_cases` on the Free tier), `LIVE_FETCH_NOT_ALLOWED` (`refresh: true` on `request_case_timeline` below PAYG), `REMOTE_FETCH_NOT_ALLOWED` (`analyze_case` needs `allowRemoteFetch: true`, or the document lives outside the allowed host list), `PARTY_SCREEN_LIMIT_REACHED` (monthly screen cap), or an account level gate (deactivated, suspended, not found, credits exhausted). | Check your CourtMesh billing and plan settings, upgrade off the Free tier, pass the flag the error names, or wait for the quota to reset. |
| 429 | Rate limited, distinguished by `code`: `RATE_LIMITED` (a request or minute/day/month cap), `DISTINCT_NAMES_LIMIT_REACHED` or `DISTINCT_CASES_LIMIT_REACHED` (an additional abuse protection was exceeded), `PDF_LIMIT_REACHED`, `LIVE_FETCH_LIMIT_REACHED`, `TOO_MANY_KEYS_FROM_IP`, `CONCURRENT_ANALYSIS_LIMIT`, or `PARTY_PROFILE_TOO_MANY_ACTIVE` (3 full profiles already queued or running; wait for one to finish). The code is shown in the tool result. | Wait the number of seconds given in `retryAfter` before retrying, the message also states when the limit resets. This client already retries a `RATE_LIMITED` 429 on a read only (GET) tool once by itself, honouring `Retry-After` capped at 60 seconds; a write (POST) tool such as `screen_party_litigation` or `analyze_case` is never retried automatically, so an error here on one of those means the call did not run and is safe to resend yourself. |
| 400 | Validation failed, or a request shape the plan does not allow: `PAGE_LIMIT_EXCEEDED` / `PAGINATION_DEPTH_EXCEEDED` (the tier's page size or pagination depth cap), `CURSOR_INVALID` (a `cursor` that is malformed, expired, or was issued for a different query). | For a plain validation failure, the tool result lists the specific field errors from the API's `details` array, fix the input and retry. For a cap or cursor problem, reduce `page`/`limit`, drop `cursor` and start the search again, or upgrade the plan. |
| 404 | The case, PDF, or timeline request was not found. `get_case_pdf_url` distinguishes `CASE_NOT_FOUND` (no such case) from `PDF_NOT_STORED` (case exists, no stored document; try `request_case_timeline` with `refresh: true`). | Double check the id or requestId. |
| 408 / 500 / 502 / 503 | Timeout or upstream failure. A 503 `PARTY_PROFILE_FULL_UNAVAILABLE` means full mode is not available (send `mode: "quick"`); `ACCOUNT_STANDING_UNAVAILABLE` and `ENTITLEMENT_UNAVAILABLE` ran nothing; a 502 `PARTY_SCREEN_SEARCH_DEGRADED` charged nothing. | Usually transient, retry later. |
| 409 | `IDEMPOTENCY_IN_PROGRESS` (an identical call is still running) or `IDEMPOTENCY_KEY_REUSED`. Neither is charged. | Wait for the first call rather than repeating it; for a reused key, send `fresh: true`. |

### Acts and sections

The nine acts tools need an API key with the `legislation` scope. Each costs 1 credit when something is returned and nothing otherwise. Slugs (`^[a-z0-9][a-z0-9-]*$`) are checked before any request is made, so a malformed one fails at once. Get slugs from `resolve_act`, `search_acts` or `lookup_section` rather than guessing them. Every result carries repeal status; check it before relying on a provision. Statute text is returned as published, with no commentary. `search_acts`, `resolve_act`, `search_sections`, `lookup_section` and `list_section_citing_cases` have a lower per minute limit than other calls and answer 429 above it. A failed check on the citing judgments list answers 502 `UPSTREAM_UNAVAILABLE`, which is safe to retry once.

When an error body carries a `requestId`, this server appends it to the reported message so it can be handed to CourtMesh support.

## Development

```bash
npm install
npm run build   # compiles TypeScript with tsc, then chmods dist/index.js executable
npm run dev      # tsc --watch
npm start        # runs the built server over stdio
```

Source layout:

- `src/index.ts`: entry point, transport selection (stdio vs Streamable HTTP), Express app for HTTP mode.
- `src/client.ts`: shared HTTP client, auth headers, and all error mapping.
- `src/tools.ts`: tool schemas (zod) and handlers, one per CourtMesh endpoint.
- `src/context.ts`: an `AsyncLocalStorage` used to carry a per request `?token=` override through to the client in HTTP mode.

See `CHANGELOG.md` for what changed in each release.

## License

MIT, Copyright 2026 Thinkscoop Technologies LLP. See `LICENSE`.

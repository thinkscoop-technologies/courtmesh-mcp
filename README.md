# @courtmesh/mcp-server

An MCP (Model Context Protocol) server for the CourtMesh public REST API. It gives any MCP capable AI client, Claude Desktop, Claude Code, Cursor, or a custom agent, tools to search and analyze Indian court case law, screen a party name for litigation history, and check corpus coverage: 310M plus case records spanning the Supreme Court, High Courts, District Courts and tribunals.

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

- **stdio** (default): the standard transport for local MCP clients such as Claude Desktop, Claude Code and Cursor. The client spawns the server process and talks to it over stdin and stdout.
- **Streamable HTTP**: pass `--http` or set `MCP_TRANSPORT=http` to run as a long lived HTTP server, mounted at `/mcp`, suitable for hosting behind a URL such as `mcp.courtmesh.ai/mcp`. A plain `GET /health` route is also available on the HTTP server itself, separate from the `check_api_health` tool, which checks the upstream CourtMesh API instead.

## Tools

| Tool | Endpoint | Credits | One line |
| --- | --- | --- | --- |
| `search_indian_court_cases` | `POST /search/cases` | No | Fast keyword and boolean search over the full 310M plus case index. |
| `semantic_search_cases` | `POST /search/cases/semantic` | Yes | AI vector search over the roughly 2M case subset with embeddings, for natural language questions about legal concepts. |
| `get_case` | `GET /cases/{id}` | No | Full case details, without AI analysis. |
| `get_case_analysis` | `GET /cases/{id}/analysis` | No | Reads any existing AI analysis for a case, read only. |
| `find_related_cases` | `GET /cases/{id}/related` | No | Other documents sharing the same case number, plus a procedural timeline. |
| `search_judges` | `GET /judges/search` | No | Autocomplete over Supreme Court and High Court judge names. |
| `analyze_case` | `POST /cases/{id}/analyze` | Yes | Triggers AI analysis of one case, asynchronous. `allowRemoteFetch: true` permits fetching the source document from a remote court host, at a 20 credit surcharge. |
| `analyze_consolidated_case` | `POST /cases/{id}/analyze-consolidated` | Yes, more | AI analysis merged across every document sharing a case number, synchronous and slow. |
| `get_case_pdf_url` | `GET /cases/{id}/pdf` | No | A time limited, encrypted link to the official judgment PDF. |
| `request_case_timeline` | `POST /request-timeline` | No, unless `refresh: true` | Reads stored order and hearing history by default (1 credit); `refresh: true` forces a live fetch from the court's own systems (20 credits, PAYG tier or above). |
| `get_case_timeline` | `GET /get-timeline/{requestId}` | No | Polls the job started by `request_case_timeline`. |
| `screen_party_litigation` | `POST /party/screen` | Yes | Litigation check for a person or company name: KYC, BGV, due diligence, and litigation/compliance screening. |
| `get_court_coverage` | `GET /coverage` | No | Corpus coverage and freshness snapshot, no authentication required. |
| `check_api_health` | `GET /health` | No | Checks CourtMesh API connectivity, no authentication required. |

Full input and output field details are in each tool's own description, visible to any connected MCP client through `tools/list`.

## Configuration examples

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config) and add:

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

### Claude Code

CLI one liner:

```bash
claude mcp add courtmesh --env COURTMESH_API_KEY=cm-your-key-here -- npx -y @courtmesh/mcp-server
```

Or add to `.mcp.json` in your project:

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

Once this server is deployed behind a public URL, point any Streamable HTTP capable MCP client at it directly, no local process required. Pass your key as a query parameter, it overrides `COURTMESH_API_KEY` for that session:

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
| 429 | Rate limited, distinguished by `code`: `RATE_LIMITED` (a request or minute/day/month cap), `DISTINCT_NAMES_LIMIT_REACHED` or `DISTINCT_CASES_LIMIT_REACHED` (too many distinct names or cases touched today), `PDF_LIMIT_REACHED`, `LIVE_FETCH_LIMIT_REACHED`, `TOO_MANY_KEYS_FROM_IP`, or `CONCURRENT_ANALYSIS_LIMIT`. | Wait the number of seconds given in `retryAfter` before retrying, the message also states when the limit resets. This client already retries a `RATE_LIMITED` 429 on a read only (GET) tool once by itself, honouring `Retry-After` capped at 60 seconds; a write (POST) tool such as `screen_party_litigation` or `analyze_case` is never retried automatically, so an error here on one of those means the call did not run and is safe to resend yourself. |
| 400 | Validation failed, or a request shape the plan does not allow: `PAGE_LIMIT_EXCEEDED` / `PAGINATION_DEPTH_EXCEEDED` (the tier's page size or pagination depth cap), `CURSOR_INVALID` (a `cursor` that is malformed, expired, or was issued for a different query). | For a plain validation failure, the tool result lists the specific field errors from the API's `details` array, fix the input and retry. For a cap or cursor problem, reduce `page`/`limit`, drop `cursor` and start the search again, or upgrade the plan. |
| 404 | The case, PDF, or timeline request was not found. `get_case_pdf_url` distinguishes `CASE_NOT_FOUND` (no such case) from `PDF_NOT_STORED` (case exists, no stored document; try `request_case_timeline` with `refresh: true`). | Double check the id or requestId. |
| 408 / 500 / 502 / 503 | Timeout or upstream failure. | Usually transient, retry later. |

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

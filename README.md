# @courtmesh/mcp-server

An MCP (Model Context Protocol) server for the CourtMesh public REST API. It gives any MCP capable AI client, Claude Desktop, Claude Code, Cursor, or a custom agent, tools to search and analyze Indian court case law: 310M plus case records spanning the Supreme Court, High Courts, District Courts and tribunals.

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
| `analyze_case` | `POST /cases/{id}/analyze` | Yes | Triggers AI analysis of one case, asynchronous. |
| `analyze_consolidated_case` | `POST /cases/{id}/analyze-consolidated` | Yes, more | AI analysis merged across every document sharing a case number, synchronous and slow. |
| `get_case_pdf_url` | `GET /cases/{id}/pdf` | No | A time limited, encrypted link to the official judgment PDF. |
| `request_case_timeline` | `POST /request-timeline` | No | Kicks off a live fetch of order and hearing history from the court's own systems. |
| `get_case_timeline` | `GET /get-timeline/{requestId}` | No | Polls the job started by `request_case_timeline`. |
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
| 403 | Account, plan, or quota gate: organization deactivated, account suspended, billing inactive, account not found, AI credits exhausted, or the daily API call quota reached (the response includes `callsToday` and `maxAllowed` when this is a quota gate). | Check your CourtMesh billing and plan settings, or wait for the quota to reset. |
| 429 | Rate limited. | Wait the number of seconds given in `retryAfter` before retrying, the message also states when the limit resets. |
| 400 | Validation failed. | The tool result lists the specific field errors from the API's `details` array, fix the input and retry. |
| 404 | The case, PDF, or timeline request was not found. | Double check the id or requestId. |
| 408 / 500 / 502 / 503 | Timeout or upstream failure. | Usually transient, retry later. |

There is one API quirk this server handles for you: `POST /search/cases/semantic` sends its HTTP 200 status before it finishes work, so a failure inside that endpoint can still arrive as HTTP 200 with a body of `{"success": false, "error": "..."}`. Every tool call checks for `success: false` in the response body in addition to the HTTP status, and reports it as a tool error either way.

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

## License

MIT, Copyright 2026 Thinkscoop Technologies LLP. See `LICENSE`.

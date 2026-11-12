/**
 * Tests for the CNR lookup and monitoring tools (src/tools.ts, src/cnr.ts).
 *
 * Each test wires the real McpServer to a real SDK Client over an in-memory
 * transport, and points the tools at a tiny local HTTP server that records
 * every request and returns canned responses. Nothing leaves loopback.
 *
 * Run: npm test   (build first, this drives dist/)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerCourtMeshTools } from '../dist/tools.js';
import { normalizeCnr, cnrForRequest } from '../dist/cnr.js';

const CNR = 'DLHC010084212021';
const NEW_TOOLS = [
  'lookup_case_by_cnr',
  'create_watchlist',
  'list_watchlists',
  'add_cases_to_watchlist',
  'remove_case_from_watchlist',
  'list_watchlist_cases',
  'get_case_changes',
];

/** Starts a recording API. `respond(req)` returns { status, body } (body undefined for an empty reply). */
async function startApi(respond) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const call = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      calls.push(call);
      const { status, body } = respond(call);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { calls, baseUrl: `http://127.0.0.1:${port}/api/v1/prod/`, close: () => new Promise((r) => server.close(r)) };
}

async function connect(baseUrl) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerCourtMeshTools(server, { baseUrl, apiKey: 'cm-' + 'a'.repeat(32) + '-abcd', sessionSalt: 'test-session' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

const text = (result) => result.content[0].text;
const ok = (data, extra = {}) => ({ status: 200, body: { success: true, data, ...extra } });

test('the seven monitoring tools are listed with substantive descriptions', async () => {
  const api = await startApi(() => ok({}));
  const { client, close } = await connect(api.baseUrl);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 25);
  for (const name of NEW_TOOLS) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} is registered`);
    assert.ok(tool.description.length > 200, `${name} has a real description`);
    assert.match(tool.description, /FREE|COSTS 1 CREDIT/, `${name} states its cost`);
  }
  assert.ok(!tools.some((t) => /webhook/i.test(t.name)), 'webhook management is deliberately not exposed');
  await close();
  await api.close();
});

test('normalizeCnr handles common spellings', () => {
  assert.equal(normalizeCnr('CNR: DLHC-01-008421-2021'), CNR);
  assert.equal(normalizeCnr('cnr no dlhc010084212021'), CNR);
  assert.equal(normalizeCnr('nope'), null);
  assert.equal(cnrForRequest('  nope '), 'nope');
});

test('lookup_case_by_cnr normalises the CNR and returns found', async () => {
  const api = await startApi(() => ok({ cnr: CNR, status: 'found', case: { id: 'c1' }, requestId: null }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({ name: 'lookup_case_by_cnr', arguments: { cnr: 'cnr: dlhc-01-008421-2021' } });
  assert.equal(api.calls[0].method, 'GET');
  assert.equal(api.calls[0].url, `/api/v1/prod/cases/by-cnr/${CNR}`);
  assert.equal(api.calls[0].headers['x-api-key'].startsWith('cm-'), true);
  assert.ok(!result.isError);
  assert.match(text(result), /"status": "found"/);
  await close();
  await api.close();
});

test('lookup_case_by_cnr sends fetch=true and explains a pending result', async () => {
  const api = await startApi(() => ({ status: 202, body: { success: true, data: { cnr: CNR, status: 'pending', requestId: 'req_1' } } }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({ name: 'lookup_case_by_cnr', arguments: { cnr: CNR, fetch: true } });
  assert.equal(api.calls[0].url, `/api/v1/prod/cases/by-cnr/${CNR}?fetch=true`);
  assert.match(text(result), /official court source is still being checked/);
  assert.match(text(result), /req_1/);
  await close();
  await api.close();
});

// From 12 Nov 2026 the API checks the official court source by default for a CNR it does not hold
// (202 pending, uncharged), fetch=false opts out, and Supreme Court CNRs are fetched too.
const SC_CNR = 'ZZAB010000012026';

test('lookup_case_by_cnr by default sends no fetch parameter and explains the 202 pending court check', async () => {
  const api = await startApi(() => ({ status: 202, body: { success: true, data: { cnr: SC_CNR, status: 'pending', requestId: 'req_2' } } }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({ name: 'lookup_case_by_cnr', arguments: { cnr: SC_CNR } });
  assert.equal(api.calls[0].url, `/api/v1/prod/cases/by-cnr/${SC_CNR}`);
  assert.notEqual(result.isError, true);
  assert.match(text(result), /official court source/);
  assert.match(text(result), /call lookup_case_by_cnr again/i);
  assert.match(text(result), /several minutes/);
  await close();
  await api.close();
});

test('lookup_case_by_cnr sends fetch=false when fetch is false, to opt out of the court check', async () => {
  const api = await startApi(() => ({ status: 404, body: { success: false, error: 'No case found for this CNR', code: 'CASE_NOT_FOUND' } }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({ name: 'lookup_case_by_cnr', arguments: { cnr: SC_CNR, fetch: false } });
  assert.equal(api.calls[0].url, `/api/v1/prod/cases/by-cnr/${SC_CNR}?fetch=false`);
  assert.equal(result.isError, true);
  assert.match(text(result), /CASE_NOT_FOUND/);
  await close();
  await api.close();
});

test('lookup_case_by_cnr describes the official source default, the fetch false opt out and the daily cap', async () => {
  const api = await startApi(() => ok({}));
  const { client, close } = await connect(api.baseUrl);
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === 'lookup_case_by_cnr');
  const all = tool.description + ' ' + tool.inputSchema.properties.fetch.description;
  assert.match(all, /by default/i);
  assert.match(all, /202/);
  assert.match(all, /fetch false/);
  assert.match(all, /Supreme Court/);
  assert.match(all, /several minutes/);
  assert.match(all, /LIVE_FETCH_LIMIT_REACHED/);
  assert.match(all, /LIVE_FETCH_NOT_ALLOWED/);
  assert.doesNotMatch(all, /always\s+404/);
  assert.doesNotMatch(all, /cannot be fetched live/);
  assert.doesNotMatch(all, /Set true only if a previous call said the CNR is not found/);
  await close();
  await api.close();
});

test('watchlist tool descriptions no longer say a Supreme Court CNR we do not hold is not found at once', async () => {
  const api = await startApi(() => ok({}));
  const { client, close } = await connect(api.baseUrl);
  const { tools } = await client.listTools();
  for (const name of ['create_watchlist', 'add_cases_to_watchlist']) {
    const tool = tools.find((t) => t.name === name);
    assert.doesNotMatch(tool.description, /Supreme Court CNR we do not hold\)/, `${name} drops the old not_found clause`);
    assert.match(tool.description, /Supreme Court/, `${name} says Supreme Court CNRs are checked too`);
  }
  await close();
  await api.close();
});

test('a LIVE_FETCH_LIMIT_REACHED 429 on a CNR lookup is not retried and says the daily court check cap is reached', async () => {
  const api = await startApi(() => ({
    status: 429,
    body: { success: false, code: 'LIVE_FETCH_LIMIT_REACHED', message: 'Daily limit reached.', retryAfter: 3600 },
  }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({ name: 'lookup_case_by_cnr', arguments: { cnr: SC_CNR } });
  assert.equal(api.calls.length, 1);
  assert.equal(result.isError, true);
  assert.match(text(result), /LIVE_FETCH_LIMIT_REACHED/);
  assert.match(text(result), /fetch false/);
  await close();
  await api.close();
});

test('a LIVE_FETCH_NOT_ALLOWED 403 on a CNR lookup with fetch true tells the model to drop fetch', async () => {
  const api = await startApi(() => ({
    status: 403,
    body: { success: false, error: 'Live fetch is not available on this plan.', code: 'LIVE_FETCH_NOT_ALLOWED' },
  }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({ name: 'lookup_case_by_cnr', arguments: { cnr: SC_CNR, fetch: true } });
  assert.equal(result.isError, true);
  assert.match(text(result), /LIVE_FETCH_NOT_ALLOWED/);
  assert.match(text(result), /lookup_case_by_cnr/);
  await close();
  await api.close();
});

test('lookup_case_by_cnr turns a 404 into a readable error result', async () => {
  const api = await startApi(() => ({ status: 404, body: { success: false, error: 'No case found for this CNR', code: 'CASE_NOT_FOUND' } }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({ name: 'lookup_case_by_cnr', arguments: { cnr: CNR } });
  assert.equal(result.isError, true);
  assert.match(text(result), /Not found \(404\)/);
  assert.match(text(result), /CASE_NOT_FOUND/);
  await close();
  await api.close();
});

test('an INVALID_CNR 400 is reported with its code and guidance, not as a page limit problem', async () => {
  const api = await startApi(() => ({ status: 400, body: { success: false, message: 'CNR is not valid', code: 'INVALID_CNR' } }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({ name: 'lookup_case_by_cnr', arguments: { cnr: 'nope' } });
  assert.equal(result.isError, true);
  assert.match(text(result), /INVALID_CNR/);
  assert.match(text(result), /16 characters/);
  assert.doesNotMatch(text(result), /plan tier/);
  await close();
  await api.close();
});

test('create_watchlist posts normalised items and sends no Idempotency-Key', async () => {
  const api = await startApi(() => ok({ id: 'wl_1', name: 'Loans', results: [{ cnr: CNR, result: 'watching' }] }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({
    name: 'create_watchlist',
    arguments: { name: 'Loans', items: [{ cnr: 'dlhc 01 008421 2021', reference: 'LOAN-42' }] },
  });
  assert.equal(api.calls[0].method, 'POST');
  assert.equal(api.calls[0].url, '/api/v1/prod/watchlists');
  assert.deepEqual(api.calls[0].body, { name: 'Loans', items: [{ cnr: CNR, reference: 'LOAN-42' }] });
  assert.equal(api.calls[0].headers['idempotency-key'], undefined);
  assert.match(text(result), /wl_1/);
  await close();
  await api.close();
});

test('create_watchlist rejects an empty name and more than 100 items before any request', async () => {
  const api = await startApi(() => ok({}));
  const { client, close } = await connect(api.baseUrl);
  const empty = await client.callTool({ name: 'create_watchlist', arguments: { name: '  ' } });
  assert.equal(empty.isError, true);
  const many = await client.callTool({
    name: 'create_watchlist',
    arguments: { name: 'x', items: Array.from({ length: 101 }, () => ({ cnr: CNR })) },
  });
  assert.equal(many.isError, true);
  assert.equal(api.calls.length, 0);
  await close();
  await api.close();
});

test('list_watchlists passes limit and cursor and surfaces the next cursor', async () => {
  const api = await startApi(() => ok([{ id: 'wl_1' }], { pagination: { nextCursor: 'cur2', hasMore: true } }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({ name: 'list_watchlists', arguments: { limit: 5, cursor: 'cur1' } });
  assert.equal(api.calls[0].url, '/api/v1/prod/watchlists?limit=5&cursor=cur1');
  assert.match(text(result), /cur2/);
  await close();
  await api.close();
});

test('add_cases_to_watchlist posts items to the right path and shows per item results', async () => {
  const api = await startApi(() =>
    ok({ results: [{ cnr: CNR, result: 'pending' }, { cnr: 'BAD', result: 'invalid', message: 'not a CNR' }] })
  );
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({
    name: 'add_cases_to_watchlist',
    arguments: { watchlist_id: 'wl_1', items: [{ cnr: CNR }, { cnr: 'BAD' }] },
  });
  assert.equal(api.calls[0].method, 'POST');
  assert.equal(api.calls[0].url, '/api/v1/prod/watchlists/wl_1/items');
  assert.deepEqual(api.calls[0].body, { items: [{ cnr: CNR }, { cnr: 'BAD' }] });
  assert.match(text(result), /"result": "invalid"/);
  await close();
  await api.close();
});

test('add_cases_to_watchlist reports a WATCH_CAP_EXCEEDED 403 with guidance', async () => {
  const api = await startApi(() => ({ status: 403, body: { success: false, error: 'Watch cap exceeded', code: 'WATCH_CAP_EXCEEDED' } }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({ name: 'add_cases_to_watchlist', arguments: { watchlist_id: 'wl_1', items: [{ cnr: CNR }] } });
  assert.equal(result.isError, true);
  assert.match(text(result), /WATCH_CAP_EXCEEDED/);
  assert.match(text(result), /remove_case_from_watchlist/);
  await close();
  await api.close();
});

test('remove_case_from_watchlist issues a DELETE and copes with an empty 204', async () => {
  const api = await startApi(() => ({ status: 204 }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({ name: 'remove_case_from_watchlist', arguments: { watchlist_id: 'wl_1', cnr: 'cnr ' + CNR.toLowerCase() } });
  assert.equal(api.calls[0].method, 'DELETE');
  assert.equal(api.calls[0].url, `/api/v1/prod/watchlists/wl_1/items/${CNR}`);
  assert.ok(!result.isError);
  assert.match(text(result), /removed/);
  await close();
  await api.close();
});

test('remove_case_from_watchlist surfaces a WATCHLIST_NOT_FOUND 404', async () => {
  const api = await startApi(() => ({ status: 404, body: { success: false, error: 'Watchlist not found', code: 'WATCHLIST_NOT_FOUND' } }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({ name: 'remove_case_from_watchlist', arguments: { watchlist_id: 'wl_x', cnr: CNR } });
  assert.equal(result.isError, true);
  assert.match(text(result), /WATCHLIST_NOT_FOUND/);
  await close();
  await api.close();
});

test('list_watchlist_cases filters by status and passes pagination', async () => {
  const api = await startApi(() => ok([{ cnr: CNR, status: 'pending' }], { pagination: { nextCursor: null, hasMore: false } }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({
    name: 'list_watchlist_cases',
    arguments: { watchlist_id: 'wl_1', status: 'pending', limit: 50 },
  });
  assert.equal(api.calls[0].url, '/api/v1/prod/watchlists/wl_1/items?status=pending&limit=50');
  assert.match(text(result), /"status": "pending"/);
  assert.doesNotMatch(text(result), /next page cursor/);
  await close();
  await api.close();
});

test('get_case_changes reads /changes with joined types, normalised cnr and cursor advice', async () => {
  const event = { id: 'evt_1', type: 'case.order_added', createdAt: 't', cnr: CNR, watchlists: [], data: {} };
  const api = await startApi(() => ok([event], { pagination: { nextCursor: 'cur9', hasMore: false } }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({
    name: 'get_case_changes',
    arguments: { since: '2026-11-01T00:00:00Z', types: ['case.order_added', 'case.disposed'], cnr: 'cnr ' + CNR, limit: 100 },
  });
  const url = new URL(api.calls[0].url, 'http://x');
  assert.equal(url.pathname, '/api/v1/prod/changes');
  assert.equal(url.searchParams.get('types'), 'case.order_added,case.disposed');
  assert.equal(url.searchParams.get('cnr'), CNR);
  assert.equal(url.searchParams.get('since'), '2026-11-01T00:00:00Z');
  assert.match(text(result), /Remember pagination\.nextCursor/);
  assert.match(text(result), /cur9/);
  await close();
  await api.close();
});

test('get_case_changes with watchlist_id reads that watchlist\'s events and an empty page still hands back the cursor', async () => {
  const api = await startApi(() => ok([], { pagination: { nextCursor: 'cur10', hasMore: false } }));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({ name: 'get_case_changes', arguments: { watchlist_id: 'wl_9', cursor: 'cur9' } });
  assert.equal(api.calls[0].url, '/api/v1/prod/watchlists/wl_9/events?cursor=cur9');
  assert.match(text(result), /cur10/);
  await close();
  await api.close();
});

test('get_case_changes rejects an unknown event type before any request', async () => {
  const api = await startApi(() => ok([]));
  const { client, close } = await connect(api.baseUrl);
  const result = await client.callTool({ name: 'get_case_changes', arguments: { types: ['case.exploded'] } });
  assert.equal(result.isError, true);
  assert.equal(api.calls.length, 0);
  await close();
  await api.close();
});

test('a CNR lookup 404 tells the model the court is not asked again for 24 hours', async () => {
  const api = await startApi(() => ({
    status: 404,
    body: { success: false, error: 'No case with this CNR was found.', code: 'CASE_NOT_FOUND', cnr: CNR, status: 'not_found' },
  }));
  const { client, close } = await connect(api.baseUrl);
  const res = await client.callTool({ name: 'lookup_case_by_cnr', arguments: { cnr: CNR, fetch: true } });
  assert.equal(res.isError, true);
  assert.match(text(res), /CASE_NOT_FOUND/);
  assert.match(text(res), /24 hours/);
  await close();
  await api.close();
});

test('list_watchlist_cases accepts the unavailable status and shows null case fields', async () => {
  const item = {
    cnr: CNR, reference: 'R1', label: null, status: 'unavailable',
    caseId: null, court: null, title: null, lastCheckedAt: null, lastChangedAt: null, snapshot: null, addedAt: '2026-11-02T00:00:00.000Z',
  };
  const api = await startApi(() => ok([item], { pagination: { nextCursor: null, hasMore: false } }));
  const { client, close } = await connect(api.baseUrl);
  const res = await client.callTool({ name: 'list_watchlist_cases', arguments: { watchlist_id: 'wl_1', status: 'unavailable' } });
  assert.notEqual(res.isError, true);
  assert.match(api.calls[0].url, /status=unavailable/);
  assert.match(text(res), /"status": ?"unavailable"/);
  await close();
  await api.close();
});

test('add_cases_to_watchlist returns cap_exceeded and cooldown not_found results as data', async () => {
  const results = [
    { cnr: CNR, result: 'cap_exceeded', message: 'The daily limit for adding case numbers has been reached. It resets at midnight IST.' },
    { cnr: 'DLHC010084212022', result: 'not_found', message: 'eCourts had no such case when we last looked. Try again tomorrow.' },
  ];
  const api = await startApi(() => ok({ results, itemCount: 3 }));
  const { client, close } = await connect(api.baseUrl);
  const res = await client.callTool({ name: 'add_cases_to_watchlist', arguments: { watchlist_id: 'wl_1', items: [{ cnr: CNR }, { cnr: 'DLHC010084212022' }] } });
  assert.notEqual(res.isError, true);
  assert.match(text(res), /cap_exceeded/);
  assert.match(text(res), /Try again tomorrow/);
  await close();
  await api.close();
});

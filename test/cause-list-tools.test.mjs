/**
 * Tests for the cause list tools (src/tools.ts, src/cause-lists.ts).
 *
 * Same arrangement as monitoring-tools.test.mjs: a real McpServer and SDK Client over an
 * in-memory transport, pointed at a recording loopback API.
 *
 * Run: npm test   (build first, this drives dist/)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
// A short lookup deadline so the stalled-body test finishes quickly. Read at import time, hence the dynamic imports.
process.env.COURTMESH_LOOKUP_TIMEOUT_MS = '600';
const { registerCourtMeshTools } = await import('../dist/tools.js');
const { request } = await import('../dist/client.js');
const { dateRangeProblems, compactCheckData, defaultCheckRange, COURT_KEY_PATTERN } = await import('../dist/cause-lists.js');

const CNR = 'ZZAB010000012024';
const MATTER = '66f1a2b3c4d5e6f7a8b9c0d1';
const COURT_KEY = 'DC:99:1:9900001:1:1';
const TOOLS = ['list_cause_listings', 'list_matter_cause_listings', 'get_court_cause_list', 'check_cause_list_for_cnrs'];

async function startApi(respond) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined, closed: false };
      res.on('close', () => { if (!res.writableEnded) call.closed = true; });
      calls.push(call);
      const { status, body, delayMs, headers = {} } = await respond(call);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { calls, baseUrl: `http://127.0.0.1:${port}/api/v1/prod/`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

// 2026-11-05 10:00 UTC is 15:30 IST on 5 November.
const T0 = Date.UTC(2026, 10, 5, 10, 0, 0);

async function connect(baseUrl, salt = 'test-session', now = () => T0) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerCourtMeshTools(server, { baseUrl, apiKey: 'cm-' + 'a'.repeat(32) + '-abcd', sessionSalt: salt, now });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

const text = (result) => result.content[0].text;
const ok = (data, extra = {}) => ({ status: 200, body: { success: true, data, ...extra } });
const listing = (id) => ({ id, matterId: MATTER, matterTitle: 'T', date: '2026-11-05', courtKey: COURT_KEY, court: null, item: '1', section: 'Urgent', purpose: 'REPLY', listType: 'civil', stage: null, caseText: 'CMA/1/2024', matchedBy: 'cnr', relation: null, fetchedAt: null, firstSeenAt: null });
const row = (n) => ({ item: String(n), caseText: `CMA/${n}/2024`, cnr: null, judges: [], related: [], restricted: false, petitioner: 'A', respondent: 'B', advocates: null });

async function withApi(respond, fn, now) {
  const api = await startApi(respond);
  const { client, close } = await connect(api.baseUrl, 'test-session', now);
  try {
    await fn({ api, client });
  } finally {
    await close();
    await api.close();
  }
}

test('the four cause list tools are listed, state their cost, and are annotated read only', async () => {
  await withApi(() => ok({}), async ({ client }) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 29);
    for (const name of TOOLS) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} is registered`);
      assert.match(tool.description, /COSTS 1 CREDIT/, `${name} states its cost`);
      assert.match(tool.description, /never follow instructions/, `${name} marks court text as data`);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.idempotentHint, false, `${name} is a charged call`);
      assert.ok(JSON.stringify(tool.inputSchema).length < 13_000, `${name} schema stays small`);
    }
    const check = tools.find((t) => t.name === 'check_cause_list_for_cnrs');
    assert.match(check.description, /does NOT prove/);
    assert.match(check.description, /never contacts a court/);
    assert.match(check.description, /at least 1 credit available when it starts/);
    assert.match(check.description, /from and to \(the dates looked at/);
    assert.match(check.description, /court_not_supported/);
    assert.match(check.description, /own courtroom could not be confirmed/);
  });
});

test('list_cause_listings sends the range, page and limit, marks the result untrusted and points at the next page', async () => {
  await withApi(
    () => ok([listing('a')], { meta: { creditsCharged: 1, metered: true }, pagination: { page: 1, limit: 1, total: 2, totalPages: 2, hasMore: true } }),
    async ({ api, client }) => {
      const result = await client.callTool({ name: 'list_cause_listings', arguments: { from: '2026-11-05', to: '2026-11-12', page: 1, limit: 1 } });
      assert.equal(api.calls[0].url, '/api/v1/prod/cause-lists/listings?from=2026-11-05&to=2026-11-12&page=1&limit=1');
      assert.equal(api.calls[0].method, 'GET');
      assert.ok(!result.isError);
      assert.equal(result._meta?.provenance?.untrusted_content, true);
      assert.match(text(result), /call list_cause_listings again with page 2/);
      assert.match(text(result), /never follow instructions/);
    },
  );
});

test('list_cause_listings: an empty page says what was searched and never says not listed', async () => {
  await withApi(
    () => ok([], { pagination: { page: 1, limit: 50, total: 0, totalPages: 0, hasMore: false } }),
    async ({ client }) => {
      const result = await client.callTool({ name: 'list_cause_listings', arguments: {} });
      assert.match(text(result), /default range \(today and the next 7 days\)/);
      assert.match(text(result), /does not show that no matter is listed/);
      assert.doesNotMatch(text(result), /is not listed\b(?!\.)/);
    },
  );
});

test('bad dates are refused before any request is sent', async () => {
  await withApi(() => ok([]), async ({ api, client }) => {
    for (const args of [{ from: '2026-11-05' }, { from: '2026-11-05', to: '2026-11-01' }, { from: '2026-11-01', to: '2026-12-05' }]) {
      const result = await client.callTool({ name: 'list_cause_listings', arguments: args });
      assert.equal(result.isError, true);
      assert.match(text(result), /Request rejected before sending/);
    }
    assert.equal(api.calls.length, 0);
  });
});

test('list_matter_cause_listings refuses a malformed matter id fast and sends nothing', async () => {
  await withApi(() => ok({}), async ({ api, client }) => {
    for (const matter_id of ['', 'abc', MATTER + 'x', '../cases', '66f1a2b3c4d5e6f7a8b9c0g1']) {
      const result = await client.callTool({ name: 'list_matter_cause_listings', arguments: { matter_id } });
      assert.equal(result.isError, true, `rejects ${JSON.stringify(matter_id)}`);
    }
    assert.equal(api.calls.length, 0);
  });
});

test('list_matter_cause_listings calls the matter path', async () => {
  await withApi(() => ok({ matter: { id: MATTER, title: 'T', courtKey: COURT_KEY }, listings: [listing('a')] }), async ({ api, client }) => {
    const result = await client.callTool({ name: 'list_matter_cause_listings', arguments: { matter_id: MATTER, from: '2026-11-05', to: '2026-11-06' } });
    assert.equal(api.calls[0].url, `/api/v1/prod/matters/${MATTER}/cause-listings?from=2026-11-05&to=2026-11-06`);
    assert.match(text(result), /courtKey/);
    assert.equal(result._meta?.provenance?.untrusted_content, true);
  });
});

test('a 404 MATTER_NOT_FOUND is an error result with guidance', async () => {
  await withApi(() => ({ status: 404, body: { success: false, code: 'MATTER_NOT_FOUND', message: 'Matter not found.', error: 'Matter not found.' } }), async ({ client }) => {
    const result = await client.callTool({ name: 'list_matter_cause_listings', arguments: { matter_id: MATTER } });
    assert.equal(result.isError, true);
    assert.match(text(result), /MATTER_NOT_FOUND/);
    assert.match(text(result), /Nothing was charged/);
  });
});

test('get_court_cause_list refuses bad court keys and sends nothing', async () => {
  await withApi(() => ok({}), async ({ api, client }) => {
    for (const court_key of ['', 'sc', 'HC:1', 'DC:99:1:9900001:1', 'DC:a:1:2:3:4', 'SC:1']) {
      const result = await client.callTool({ name: 'get_court_cause_list', arguments: { court_key, date: '2026-11-05' } });
      assert.equal(result.isError, true, `rejects ${JSON.stringify(court_key)}`);
    }
    const bad = await client.callTool({ name: 'get_court_cause_list', arguments: { court_key: 'SC', date: '2026-02-30' } });
    assert.equal(bad.isError, true);
    assert.equal(api.calls.length, 0);
  });
  for (const key of ['SC', 'HC:99:2', COURT_KEY]) assert.ok(COURT_KEY_PATTERN.test(key));
});

test('get_court_cause_list: an unavailable list is a free success that does not claim absence', async () => {
  await withApi(
    () => ok({ courtKey: COURT_KEY, date: '2026-11-05', status: 'unavailable', complete: false, fetchedAt: null, court: null, rows: [] }, { meta: { creditsCharged: 0, metered: true } }),
    async ({ api, client }) => {
      const result = await client.callTool({ name: 'get_court_cause_list', arguments: { court_key: COURT_KEY, date: '2026-11-05' } });
      assert.equal(api.calls[0].url, `/api/v1/prod/cause-lists/court?courtKey=${encodeURIComponent(COURT_KEY)}&date=2026-11-05`);
      assert.ok(!result.isError);
      assert.match(text(result), /Status unavailable/);
      assert.match(text(result), /does not show that any case is not listed/);
    },
  );
});

test('get_court_cause_list pages a big list in rows, with nextOffset, and later pages cost no new call', async () => {
  const rows = Array.from({ length: 450 }, (_, i) => row(i));
  await withApi(
    () => ok({ courtKey: COURT_KEY, date: '2026-11-05', status: 'ok', complete: true, fetchedAt: 'x', court: null, rows }, { meta: { creditsCharged: 1, metered: true } }),
    async ({ api, client }) => {
      const first = await client.callTool({ name: 'get_court_cause_list', arguments: { court_key: COURT_KEY, date: '2026-11-05', limit: 200 } });
      const one = JSON.parse(text(first).slice(text(first).indexOf('{')));
      assert.equal(one.data.rows.length, 200);
      assert.equal(one.data.rowsTotal, 450);
      assert.equal(one.data.nextOffset, 200);
      assert.match(text(first), /offset 200/);
      const second = await client.callTool({ name: 'get_court_cause_list', arguments: { court_key: COURT_KEY, date: '2026-11-05', limit: 200, offset: 200 } });
      const two = JSON.parse(text(second).slice(text(second).indexOf('{')));
      assert.equal(two.data.rows[0].item, '200');
      assert.match(text(second), /no new charge was made/);
      const third = await client.callTool({ name: 'get_court_cause_list', arguments: { court_key: COURT_KEY, date: '2026-11-05', limit: 200, offset: 400 } });
      const last = JSON.parse(text(third).slice(text(third).indexOf('{')));
      assert.equal(last.data.rows.length, 50);
      assert.equal(last.data.nextOffset, null);
      assert.equal(api.calls.length, 1, 'one charged read served all three pages');
    },
  );
});

test('get_court_cause_list shrinks an oversized page instead of cutting it silently', async () => {
  const fat = (i) => ({ ...row(i), caseText: 'x'.repeat(2000) });
  const rows = Array.from({ length: 300 }, (_, i) => fat(i));
  await withApi(
    () => ok({ courtKey: COURT_KEY, date: '2026-11-05', status: 'ok', complete: true, fetchedAt: 'x', court: null, rows }),
    async ({ client }) => {
      const result = await client.callTool({ name: 'get_court_cause_list', arguments: { court_key: COURT_KEY, date: '2026-11-05', limit: 300 } });
      assert.ok(!result.isError);
      assert.ok(text(result).length <= 125_000 + 2000);
      const parsed = JSON.parse(text(result).slice(text(result).indexOf('{')));
      assert.ok(parsed.data.rows.length < 300);
      assert.equal(parsed.data.nextOffset, parsed.data.rows.length);
    },
  );
});

test('a 502 UPSTREAM_UNAVAILABLE is an error result that says it was not charged and is not retried by the client', async () => {
  await withApi(
    () => ({ status: 502, body: { success: false, code: 'UPSTREAM_UNAVAILABLE', message: 'Cause lists are temporarily unavailable. Please retry shortly. You have not been charged.', error: 'Cause lists are temporarily unavailable. Please retry shortly. You have not been charged.' } }),
    async ({ api, client }) => {
      const result = await client.callTool({ name: 'list_cause_listings', arguments: {} });
      assert.equal(result.isError, true);
      assert.match(text(result), /502/);
      assert.match(text(result), /UPSTREAM_UNAVAILABLE/);
      assert.match(text(result), /nothing was charged/);
      assert.equal(api.calls.length, 1);
    },
  );
});

test('a 403 CAUSE_LISTS_NOT_ENABLED says retrying will not help', async () => {
  await withApi(
    () => ({ status: 403, body: { success: false, code: 'CAUSE_LISTS_NOT_ENABLED', message: 'This account does not have access to cause lists.', error: 'This account does not have access to cause lists.' } }),
    async ({ client }) => {
      const result = await client.callTool({ name: 'list_cause_listings', arguments: {} });
      assert.equal(result.isError, true);
      assert.match(text(result), /CAUSE_LISTS_NOT_ENABLED/);
      assert.match(text(result), /will not help/);
    },
  );
});

const CHECK_DATA = {
  results: [
    { cnr: CNR, status: 'listed', reason: null, courtKey: COURT_KEY, dates: [{ date: '2026-11-05', status: 'ok', complete: true, fetchedAt: null }], listings: [{ date: '2026-11-05', courtKey: COURT_KEY, court: null, item: '1', section: 'S', purpose: 'P', listType: 'civil', stage: null, caseText: 'CMA/1/2024', matchedBy: 'cnr', relation: null, fetchedAt: null }] },
    { cnr: 'ZZAB010000022024', status: 'no_entry_found', reason: null, courtKey: 'HC:99:1', dates: [{ date: '2026-11-05', status: 'partial', complete: false, fetchedAt: null }], listings: [] },
  ],
  summary: { listed: 1, noEntryFound: 1, listNotRead: 0, cannotCheck: 0, notWatched: 0 },
};

test('check_cause_list_for_cnrs posts normalised CNRs and an Idempotency-Key, and warns on no_entry_found', async () => {
  await withApi(() => ok(CHECK_DATA, { meta: { creditsCharged: 2, metered: true } }), async ({ api, client }) => {
    const result = await client.callTool({ name: 'check_cause_list_for_cnrs', arguments: { cnrs: ['cnr: zzab-01-000001-2024', 'ZZAB010000022024'], from: '2026-11-05', to: '2026-11-06' } });
    assert.equal(api.calls[0].method, 'POST');
    assert.equal(api.calls[0].url, '/api/v1/prod/cause-lists/check');
    assert.deepEqual(api.calls[0].body, { cnrs: [CNR, 'ZZAB010000022024'], from: '2026-11-05', to: '2026-11-06' });
    assert.match(api.calls[0].headers['idempotency-key'], /^[0-9a-f]{64}$/);
    assert.ok(!result.isError);
    assert.match(text(result), /no_entry_found does not prove a case is not listed/);
    assert.equal(result._meta?.provenance?.untrusted_content, true);
  });
});

test('check_cause_list_for_cnrs: the same call replays the key, fresh changes it', async () => {
  await withApi(() => ok(CHECK_DATA), async ({ api, client }) => {
    await client.callTool({ name: 'check_cause_list_for_cnrs', arguments: { cnrs: [CNR] } });
    await client.callTool({ name: 'check_cause_list_for_cnrs', arguments: { cnrs: [CNR] } });
    await client.callTool({ name: 'check_cause_list_for_cnrs', arguments: { cnrs: [CNR], fresh: true } });
    assert.equal(api.calls[0].headers['idempotency-key'], api.calls[1].headers['idempotency-key']);
    assert.notEqual(api.calls[0].headers['idempotency-key'], api.calls[2].headers['idempotency-key']);
    assert.deepEqual(api.calls[2].body, { cnrs: [CNR], from: '2026-11-05', to: '2026-11-06' }, 'fresh is never sent; the default range is sent resolved');
  });
});

test('check_cause_list_for_cnrs refuses 0 or 101 CNRs and a range over 7 days without a request', async () => {
  await withApi(() => ok(CHECK_DATA), async ({ api, client }) => {
    for (const args of [{ cnrs: [] }, { cnrs: Array.from({ length: 101 }, () => CNR) }, { cnrs: [CNR], from: '2026-11-01', to: '2026-11-09' }, { cnrs: [CNR], from: '2026-11-01' }]) {
      const result = await client.callTool({ name: 'check_cause_list_for_cnrs', arguments: args });
      assert.equal(result.isError, true);
    }
    assert.equal(api.calls.length, 0);
  });
});

test('check_cause_list_for_cnrs: an oversized result is compacted with counts, not cut silently', async () => {
  const bigListing = { date: '2026-11-05', courtKey: COURT_KEY, court: null, item: '1', section: 'S'.repeat(3000), purpose: 'P', listType: 'civil', stage: null, caseText: 'C', matchedBy: 'cnr', relation: null, fetchedAt: null };
  const results = Array.from({ length: 30 }, (_, i) => ({ cnr: CNR, status: 'listed', reason: null, courtKey: COURT_KEY, dates: [], listings: Array.from({ length: 6 }, () => bigListing) }));
  await withApi(() => ok({ results, summary: { listed: 30, noEntryFound: 0, listNotRead: 0, cannotCheck: 0, notWatched: 0 } }), async ({ client }) => {
    const result = await client.callTool({ name: 'check_cause_list_for_cnrs', arguments: { cnrs: [CNR] } });
    assert.ok(!result.isError);
    assert.match(text(result), /too large/);
    assert.match(text(result), /listingCount/);
    assert.ok(text(result).length < 125_000);
  });
  const c = compactCheckData({ results: [{ cnr: 'x', listings: [1, 2, 3, 4, 5], dates: [1] }] });
  assert.equal(c.omittedListings, 2);
  assert.equal(c.data.results[0].listingCount, 5);
});

test('cancelling a call aborts the HTTP request to the API', async () => {
  const api = await startApi(() => ({ status: 200, body: { success: true, data: [] }, delayMs: 5000 }));
  const { client, close } = await connect(api.baseUrl);
  try {
    const controller = new AbortController();
    const pending = client.callTool({ name: 'list_cause_listings', arguments: {} }, undefined, { signal: controller.signal });
    for (let i = 0; i < 50 && api.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(api.calls.length, 1, 'request reached the API');
    controller.abort();
    await assert.rejects(pending);
    for (let i = 0; i < 50 && !api.calls[0].closed; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(api.calls[0].closed, true, 'the backend connection was closed on cancellation');
  } finally {
    await close();
    await api.close();
  }
});

test('dateRangeProblems', () => {
  assert.deepEqual(dateRangeProblems(undefined, undefined, 7), []);
  assert.deepEqual(dateRangeProblems('2026-11-01', '2026-11-08', 7), []);
  assert.deepEqual(dateRangeProblems('2026-11-01', '2026-11-09', 7), ['from and to can be at most 7 days apart.']);
  assert.deepEqual(dateRangeProblems('2026-11-01', undefined, 7), ['Send both from and to, or neither.']);
});

test('check_cause_list_for_cnrs: a call in the next 5 minute bucket is a new key; inside the bucket it is the same key', async () => {
  let now = T0;
  await withApi(() => ok(CHECK_DATA), async ({ api, client }) => {
    const call = () => client.callTool({ name: 'check_cause_list_for_cnrs', arguments: { cnrs: [CNR] } });
    await call();
    now = T0 + 60_000; // same bucket
    await call();
    now = T0 + 6 * 60_000; // later bucket
    await call();
    const keys = api.calls.map((c) => c.headers['idempotency-key']);
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
  }, () => now);
});

test('check_cause_list_for_cnrs: the default range is resolved in IST, so after IST midnight a call with no dates is a new key', async () => {
  // 18:29 UTC on 5 Nov is 23:59 IST; 18:31 UTC is 00:01 IST on 6 Nov. Same 5 minute bucket cannot hold both, so use
  // a bucket-aligned pair: 18:25 UTC (23:55 IST) and 18:30 UTC (00:00 IST) are adjacent buckets, which would differ
  // anyway. To isolate the date, compare a call at 18:30:00 with one at 18:34:59 (same bucket, same IST day) and with
  // one for the same bucket on the previous IST day via the resolved range.
  assert.deepEqual(defaultCheckRange(Date.UTC(2026, 10, 5, 18, 29, 0)), { from: '2026-11-05', to: '2026-11-06' });
  assert.deepEqual(defaultCheckRange(Date.UTC(2026, 10, 5, 18, 31, 0)), { from: '2026-11-06', to: '2026-11-07' });
  let now = Date.UTC(2026, 10, 5, 18, 25, 0);
  await withApi(() => ok(CHECK_DATA), async ({ api, client }) => {
    const call = () => client.callTool({ name: 'check_cause_list_for_cnrs', arguments: { cnrs: [CNR] } });
    await call(); // 23:55 IST on 5 Nov
    now = Date.UTC(2026, 10, 5, 18, 31, 0); // 00:01 IST on 6 Nov
    await call();
    assert.deepEqual(api.calls[0].body, { cnrs: [CNR], from: '2026-11-05', to: '2026-11-06' });
    assert.deepEqual(api.calls[1].body, { cnrs: [CNR], from: '2026-11-06', to: '2026-11-07' });
    assert.notEqual(api.calls[0].headers['idempotency-key'], api.calls[1].headers['idempotency-key']);
  }, () => now);
});

test('check_cause_list_for_cnrs: a replay says it may be out of date, names the window and points at fresh', async () => {
  const api = await startApi(() => ({ status: 200, body: { success: true, data: { ...CHECK_DATA, from: '2026-11-05', to: '2026-11-06' } }, headers: { 'idempotency-replayed': 'true' } }));
  const { client, close } = await connect(api.baseUrl);
  try {
    const result = await client.callTool({ name: 'check_cause_list_for_cnrs', arguments: { cnrs: [CNR] } });
    assert.match(text(result), /Replayed/);
    assert.match(text(result), /may be out of date/);
    assert.match(text(result), /2026-11-05 to 2026-11-06/);
    assert.match(text(result), /fresh true/);
  } finally {
    await close();
    await api.close();
  }
});

test('check_cause_list_for_cnrs rejects an invalid CNR locally, naming it, without a request', async () => {
  await withApi(() => ok(CHECK_DATA), async ({ api, client }) => {
    const result = await client.callTool({ name: 'check_cause_list_for_cnrs', arguments: { cnrs: [CNR, 'not-a-cnr'] } });
    assert.equal(result.isError, true);
    assert.match(text(result), /cnrs\.1: "not-a-cnr" is not a valid CNR/);
    assert.equal(api.calls.length, 0);
  });
});

test('check_cause_list_for_cnrs refuses CNRs times dates over 300 locally and allows exactly 300', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `ZZAB01${String(i + 1).padStart(6, '0')}2024`);
  await withApi(() => ok(CHECK_DATA), async ({ api, client }) => {
    const over = await client.callTool({ name: 'check_cause_list_for_cnrs', arguments: { cnrs: many(38), from: '2026-11-01', to: '2026-11-08' } });
    assert.equal(over.isError, true);
    assert.match(text(over), /A call can cover at most 300 CNR and date pairs\. This one asks for 38 CNRs over 8 dates/);
    assert.equal(api.calls.length, 0);
    for (const args of [{ cnrs: many(100) }, { cnrs: many(100), from: '2026-11-01', to: '2026-11-03' }, { cnrs: many(37), from: '2026-11-01', to: '2026-11-08' }, { cnrs: [...many(37), 'zzab-01-000001-2024'], from: '2026-11-01', to: '2026-11-08' }]) {
      const result = await client.callTool({ name: 'check_cause_list_for_cnrs', arguments: args });
      assert.ok(!result.isError);
    }
    assert.equal(api.calls.length, 4, 'a repeat is removed before counting');
  });
});

test('the check description documents the response fields, reasons, limits and the late 402 and 503', async () => {
  await withApi(() => ok({}), async ({ client }) => {
    const { tools } = await client.listTools();
    const d = tools.find((t) => t.name === 'check_cause_list_for_cnrs').description;
    for (const needle of ['no_case_identity', 'related_key', 'dates[].status is none', 'at most 300', 'credits due cannot be', 'SETTLEMENT_UNCONFIRMED', 'ENTITLEMENT_UNAVAILABLE', 'same 5 minute window']) {
      assert.ok(d.includes(needle), needle);
    }
    assert.doesNotMatch(tools.find((t) => t.name === 'list_cause_listings').description, /diary or number/);
  });
});

test('a court list page served from the session reports creditsCharged 0 and servedFromSession, with the remaining time', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(i));
  let now = T0;
  await withApi(
    () => ok({ courtKey: COURT_KEY, date: '2026-11-05', status: 'ok', complete: true, fetchedAt: 'x', court: null, rows }, { meta: { creditsCharged: 1, metered: true } }),
    async ({ api, client }) => {
      const first = await client.callTool({ name: 'get_court_cause_list', arguments: { court_key: COURT_KEY, date: '2026-11-05', limit: 10 } });
      const one = JSON.parse(text(first).slice(text(first).indexOf('{')));
      assert.equal(one.meta.creditsCharged, 1);
      assert.equal(one.meta.servedFromSession, undefined);
      assert.match(text(first), /for about 5 minutes more/);
      now = T0 + 3 * 60_000;
      const second = await client.callTool({ name: 'get_court_cause_list', arguments: { court_key: COURT_KEY, date: '2026-11-05', limit: 10, offset: 10 } });
      const two = JSON.parse(text(second).slice(text(second).indexOf('{')));
      assert.equal(two.meta.creditsCharged, 0);
      assert.equal(two.meta.servedFromSession, true);
      assert.match(text(second), /stays available for about 2 minutes more/);
      assert.equal(api.calls.length, 1);
      now = T0 + 6 * 60_000; // expired: read again, charged again
      await client.callTool({ name: 'get_court_cause_list', arguments: { court_key: COURT_KEY, date: '2026-11-05', limit: 10, offset: 10 } });
      assert.equal(api.calls.length, 2);
    },
    () => now,
  );
});

test('a response that sends headers and then stalls on the body still hits the deadline', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"success":true,"data":[');
    // never ends
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/prod/`;
  const { client, close } = await connect(baseUrl);
  try {
    const started = Date.now();
    const result = await client.callTool({ name: 'list_cause_listings', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(text(result), /timed out/);
    assert.ok(Date.now() - started < 5000, 'failed at the deadline, not after a hang');
  } finally {
    await close();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('a cancelled call does not sit out a 429 back-off', async () => {
  const api = await startApi(() => ({ status: 429, body: { success: false, code: 'RATE_LIMITED', retryAfter: 30, message: 'slow down' } }));
  try {
    const controller = new AbortController();
    const started = Date.now();
    const pending = request({ baseUrl: api.baseUrl, apiKey: 'cm-' + 'a'.repeat(32) + '-abcd', path: 'cause-lists/listings', signal: controller.signal });
    for (let i = 0; i < 50 && api.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.ok(Date.now() - started < 3000, 'did not wait out the 30 second back-off');
  } finally {
    await api.close();
  }
});

test('a 503 SETTLEMENT_UNCONFIRMED is an error result that says not to retry and to check the balance', async () => {
  await withApi(
    () => ({ status: 503, body: { success: false, code: 'SETTLEMENT_UNCONFIRMED', message: 'We could not confirm the credit charge for this call, so no results were returned. Please check your usage before retrying.', error: 'We could not confirm the credit charge for this call, so no results were returned. Please check your usage before retrying.' } }),
    async ({ api, client }) => {
      const result = await client.callTool({ name: 'check_cause_list_for_cnrs', arguments: { cnrs: [CNR] } });
      assert.equal(result.isError, true);
      assert.match(text(result), /SETTLEMENT_UNCONFIRMED/);
      assert.match(text(result), /Do not retry yet/);
      assert.match(text(result), /get_api_usage/);
      assert.equal(api.calls.length, 1);
    },
  );
});

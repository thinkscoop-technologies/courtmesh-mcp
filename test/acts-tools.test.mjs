/**
 * Tests for the Acts and sections tools (src/tools.ts, src/client.ts).
 *
 * Same wiring as monitoring-tools.test.mjs: the real McpServer talks to a real
 * SDK Client over an in-memory transport, and the tools call a local recording
 * HTTP server. Nothing leaves loopback.
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

const ACTS_TOOLS = [
  'search_acts',
  'resolve_act',
  'get_act',
  'get_act_history',
  'list_act_sections',
  'get_section',
  'search_sections',
  'lookup_section',
  'list_section_citing_cases',
];

async function startApi(respond) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers });
    const { status, body } = respond(calls[calls.length - 1]);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
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

async function withApi(respond, fn) {
  const api = await startApi(respond);
  const { client, close } = await connect(api.baseUrl);
  try {
    await fn(client, api);
  } finally {
    await close();
    await api.close();
  }
}

test('the nine acts tools are listed with their cost, and the server exposes 34 tools', async () => {
  await withApi(() => ok({}), async (client) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 34);
    for (const name of ACTS_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} is registered`);
      assert.match(tool.description, /COSTS 1 CREDIT/, `${name} states its cost`);
      assert.doesNotMatch(tool.description, /[\u2013\u2014]/, `${name} has no em or en dash`);
      assert.doesNotMatch(tool.description, /opensearch|qdrant|mongo/i, `${name} names no engine`);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
    assert.match(byName.list_section_citing_cases, /EMPTY LIST DOES NOT MEAN NO JUDGMENT/);
    assert.match(byName.get_act_history, /does NOT map old sections to new ones/);
    assert.match(byName.get_section, /repeal/i);
    assert.match(byName.get_act, /resolve_act/);
    assert.match(byName.get_section, /lookup_section/);
  });
});

test('a malformed slug is refused with no network call, for every slug field', async () => {
  const bad = ['Indian-Penal-Code', '../etc/passwd', 'a/b', '-leading', 'has space', 'x?y=1', ''];
  await withApi(() => ok({}), async (client, api) => {
    for (const slug of bad) {
      for (const [name, args] of [
        ['get_act', { slug }],
        ['get_act_history', { slug }],
        ['list_act_sections', { slug }],
        ['get_section', { slug, sectionSlug: 'section-302' }],
        ['get_section', { slug: 'indian-penal-code-1860', sectionSlug: slug }],
        ['list_section_citing_cases', { slug, sectionSlug: 'section-302' }],
        ['list_section_citing_cases', { slug: 'indian-penal-code-1860', sectionSlug: slug }],
        ['search_sections', { q: 'murder', act: slug }],
      ]) {
        if (name === 'search_sections' && slug === '') continue; // empty act is a different failure shape
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} must be refused`);
      }
    }
    assert.equal(api.calls.length, 0, 'no request was made');
  });
});

test('q lengths are enforced before any request', async () => {
  await withApi(() => ok({}), async (client, api) => {
    for (const [name, q] of [
      ['search_acts', 'x'],
      ['resolve_act', 'x'],
      ['search_sections', 'x'],
      ['search_acts', 'x'.repeat(201)],
      ['lookup_section', ''],
      ['lookup_section', 'x'.repeat(201)],
      ['lookup_section', 'bad\u0000char'],
    ]) {
      const result = await client.callTool({ name, arguments: { q } });
      assert.equal(result.isError, true, `${name} with q of length ${q.length} must be refused`);
    }
    assert.equal(api.calls.length, 0);
    // The boundaries themselves go through.
    await client.callTool({ name: 'lookup_section', arguments: { q: 's' } });
    await client.callTool({ name: 'search_acts', arguments: { q: 'x'.repeat(200) } });
    assert.equal(api.calls.length, 2);
  });
});

test('each tool calls the right path with the right query', async () => {
  await withApi(() => ok([], { pagination: { page: 1, limit: 20, total: 0, hasMore: false } }), async (client, api) => {
    await client.callTool({ name: 'search_acts', arguments: { q: 'negotiable instruments', docClass: 'act', jurisdiction: 'central', yearFrom: 1880, yearTo: 1890, page: 2, limit: 5 } });
    await client.callTool({ name: 'resolve_act', arguments: { q: 'Cr.P.C.' } });
    await client.callTool({ name: 'get_act', arguments: { slug: 'indian-penal-code-1860' } });
    await client.callTool({ name: 'get_act_history', arguments: { slug: 'indian-penal-code-1860' } });
    await client.callTool({ name: 'list_act_sections', arguments: { slug: 'indian-penal-code-1860', page: 3, limit: 50 } });
    await client.callTool({ name: 'get_section', arguments: { slug: 'indian-penal-code-1860', sectionSlug: 'section-302' } });
    await client.callTool({ name: 'search_sections', arguments: { q: 'punishment for murder', act: 'indian-penal-code-1860', number: '498A' } });
    await client.callTool({ name: 'lookup_section', arguments: { q: 'section 302 IPC' } });
    await client.callTool({ name: 'list_section_citing_cases', arguments: { slug: 'indian-penal-code-1860', sectionSlug: 'section-302', limit: 10 } });

    const base = '/api/v1/prod';
    assert.deepEqual(
      api.calls.map((c) => `${c.method} ${c.url}`),
      [
        `GET ${base}/acts/search?q=negotiable+instruments&docClass=act&jurisdiction=central&yearFrom=1880&yearTo=1890&page=2&limit=5`,
        `GET ${base}/acts/resolve?q=Cr.P.C.`,
        `GET ${base}/acts/indian-penal-code-1860`,
        `GET ${base}/acts/indian-penal-code-1860/history`,
        `GET ${base}/acts/indian-penal-code-1860/sections?page=3&limit=50`,
        `GET ${base}/acts/indian-penal-code-1860/sections/section-302`,
        `GET ${base}/sections/search?q=punishment+for+murder&act=indian-penal-code-1860&number=498A`,
        `GET ${base}/sections/lookup?q=section+302+IPC`,
        `GET ${base}/acts/indian-penal-code-1860/sections/section-302/citing-cases?limit=10`,
      ]
    );
    for (const call of api.calls) {
      assert.equal(call.headers['idempotency-key'], undefined, 'reads send no Idempotency-Key');
      assert.ok(call.headers['x-api-key'].startsWith('cm-'));
    }
  });
});

test('a query is percent encoded and cannot inject extra parameters', async () => {
  await withApi(() => ok({ query: 'x', matches: [{ ambiguous: false }] }), async (client, api) => {
    await client.callTool({ name: 'lookup_section', arguments: { q: 'article 21 & limit=100#frag' } });
    const url = new URL(api.calls[0].url, 'http://x');
    assert.equal(url.pathname, '/api/v1/prod/sections/lookup');
    assert.equal(url.searchParams.get('q'), 'article 21 & limit=100#frag');
    assert.equal(url.searchParams.get('limit'), null);
  });
});

test('an empty citing judgments list is returned with its note and is not an error', async () => {
  const note = 'Not an exhaustive list of every judgment applying this provision. An empty list does not mean no judgment applied it.';
  await withApi(
    () => ok(
      { section: { actSlug: 'a', slug: 'section-1', number: '1' }, listAvailable: true, note, total: 0, totalIsLowerBound: false, cases: [] },
      { meta: { creditsCharged: 0, metered: true }, pagination: { limit: 20, hasMore: false, nextCursor: null } }
    ),
    async (client) => {
      const result = await client.callTool({ name: 'list_section_citing_cases', arguments: { slug: 'a', sectionSlug: 'section-1' } });
      assert.ok(!result.isError);
      assert.match(text(result), /nothing was charged/);
      assert.match(text(result), /does not mean no judgment applied/);
      assert.match(text(result), /"cases": \[\]/);
      assert.match(text(result), /"note": "Not an exhaustive list/);
    }
  );
});

test('citing cases with listAvailable false is not read as "none exist", and withheld flags surface', async () => {
  await withApi(
    () => ({
      status: 200,
      body: {
        success: true,
        data: { section: {}, listAvailable: false, note: 'n', total: 0, totalIsLowerBound: false, cases: [] },
        meta: { someRecordsWithheld: true, restrictedCheckDegraded: true },
        pagination: { limit: 20, hasMore: false, nextCursor: null },
      },
    }),
    async (client) => {
      const result = await client.callTool({ name: 'list_section_citing_cases', arguments: { slug: 'a', sectionSlug: 'b' } });
      assert.match(text(result), /says nothing about whether any exist/);
      assert.match(text(result), /withheld/);
      assert.match(text(result), /masked/);
    }
  );
});

test('citing cases passes the cursor back unmodified and surfaces the next cursor', async () => {
  await withApi(
    () => ok(
      { section: {}, listAvailable: true, note: 'n', total: 40, totalIsLowerBound: false, cases: [{ id: '65f0c0ffee0000000000abcd' }] },
      { pagination: { limit: 1, hasMore: true, nextCursor: 'opaque.cursor_1' } }
    ),
    async (client, api) => {
      const result = await client.callTool({ name: 'list_section_citing_cases', arguments: { slug: 'a', sectionSlug: 'b', cursor: 'abc.def_9', limit: 1 } });
      assert.equal(api.calls[0].url, '/api/v1/prod/acts/a/sections/b/citing-cases?cursor=abc.def_9&limit=1');
      assert.match(text(result), /opaque\.cursor_1/);
    }
  );
});

test('ACT_NOT_FOUND maps to a readable error that points at resolve_act', async () => {
  await withApi(
    () => ({ status: 404, body: { success: false, error: 'No published act matches this slug.', code: 'ACT_NOT_FOUND' } }),
    async (client) => {
      const result = await client.callTool({ name: 'get_act', arguments: { slug: 'no-such-act-1999' } });
      assert.equal(result.isError, true);
      assert.match(text(result), /Not found \(404\)/);
      assert.match(text(result), /ACT_NOT_FOUND/);
      assert.match(text(result), /resolve_act/);
      assert.match(text(result), /Nothing was charged/);
    }
  );
});

test('SECTION_NOT_FOUND maps to a readable error that points at lookup_section', async () => {
  await withApi(
    () => ({ status: 404, body: { success: false, error: 'No published provision matches this act and section.', code: 'SECTION_NOT_FOUND' } }),
    async (client) => {
      const result = await client.callTool({ name: 'get_section', arguments: { slug: 'indian-penal-code-1860', sectionSlug: 'section-9999' } });
      assert.equal(result.isError, true);
      assert.match(text(result), /SECTION_NOT_FOUND/);
      assert.match(text(result), /lookup_section/);
      assert.match(text(result), /list_act_sections/);
    }
  );
});

test('UPSTREAM_UNAVAILABLE on citing cases says it is safe to retry and was not charged', async () => {
  await withApi(
    () => ({ status: 502, body: { success: false, error: 'Citing judgments are temporarily unavailable. Please try again shortly.', code: 'UPSTREAM_UNAVAILABLE' } }),
    async (client) => {
      const result = await client.callTool({ name: 'list_section_citing_cases', arguments: { slug: 'a', sectionSlug: 'b' } });
      assert.equal(result.isError, true);
      assert.match(text(result), /UPSTREAM_UNAVAILABLE/);
      assert.match(text(result), /safe to retry/);
    }
  );
});

test('a 403 for a key without the legislation scope is reported as an access gate', async () => {
  await withApi(
    () => ({ status: 403, body: { success: false, error: 'This key does not have the legislation scope.', code: 'FORBIDDEN_SCOPE' } }),
    async (client) => {
      const result = await client.callTool({ name: 'search_acts', arguments: { q: 'penal code' } });
      assert.equal(result.isError, true);
      assert.match(text(result), /Access denied \(403\)/);
      assert.match(text(result), /FORBIDDEN_SCOPE/);
    }
  );
});

test('search results with weakMatch or no rows say so; lookup flags ambiguity', async () => {
  await withApi(
    (call) => {
      if (call.url.startsWith('/api/v1/prod/acts/search')) return ok([], { meta: { weakMatch: true }, pagination: { page: 1, limit: 20, total: 0, hasMore: false } });
      return ok({ query: '302', matches: [{ section: { actSlug: 'x', slug: 'section-302' }, matchedBy: 'number_only', ambiguous: true }] });
    },
    async (client) => {
      const weak = await client.callTool({ name: 'search_acts', arguments: { q: 'zzzz qqqq' } });
      assert.match(text(weak), /Nothing was returned and nothing was charged/);
      assert.match(text(weak), /Weak match/);
      const amb = await client.callTool({ name: 'lookup_section', arguments: { q: '302' } });
      assert.match(text(amb), /Ambiguous/);
    }
  );
});

test('the act history result carries the act level caveat', async () => {
  await withApi(
    () => ok({ slug: 'indian-penal-code-1860', succession: [], amendments: [], stateAmendments: [], editions: [], instruments: [], instrumentCounts: {} }),
    async (client) => {
      const result = await client.callTool({ name: 'get_act_history', arguments: { slug: 'indian-penal-code-1860' } });
      assert.match(text(result), /does not map old sections to new ones/);
    }
  );
});

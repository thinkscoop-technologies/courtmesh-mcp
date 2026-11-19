/**
 * Tests for the party screen output shaping (src/party-screen.ts) and the batch rerun of items whose
 * search did not finish. A real McpServer and SDK Client over an in-memory transport, pointed at a
 * recording loopback API. Nothing leaves loopback.
 *
 * Run: npm test   (build first, this drives dist/)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerCourtMeshTools } from '../dist/tools.js';
const SALT = 'test-session';

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

async function connect(baseUrl) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerCourtMeshTools(server, { baseUrl, apiKey: 'cm-' + 'a'.repeat(32) + '-abcd', sessionSalt: SALT });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

async function withApi(respond, fn) {
  const api = await startApi(respond);
  const { client, close } = await connect(api.baseUrl);
  try {
    await fn({ api, client });
  } finally {
    await close();
    await api.close();
  }
}

const text = (result) => result.content[0].text;
const json = (result) => JSON.parse(text(result).slice(text(result).indexOf('{')));
const ok = (data, extra = {}) => ({ status: 200, body: { success: true, data, ...extra } });

const match = (n, extra = {}) => ({
  caseId: String(n).padStart(24, '0'),
  title: `STATE vs RAVI EXAMPLEKAR ${n}`,
  court: 'District Court of Example',
  cnr: 'ZZAB010000012024',
  caseType: 'Criminal Case',
  partyRole: 'respondent',
  petitioners: ['STATE'],
  respondents: ['RAVI EXAMPLEKAR'],
  summary: '',
  casePageUrl: 'https://example.invalid/case/1',
  confidence: { band: 'possible', score: 0.7, calibrated: 0.7, engine: 'rules' },
  evidence: { signals: [{ name: 'name-similarity', status: 'matched', weight: 'moderate', evidence: 'x'.repeat(200) }], strategies: ['original'] },
  rationale: 'Scored on name similarity plus the supporting evidence listed.',
  status: 'disposed',
  identity: { verdict: 'possible', checks: [{ field: 'name', status: 'matched', evidence: 'RAVI EXAMPLEKAR' }], toConfirm: 'Give the father.' },
  ...extra,
});
const screen = (matches) => ({
  query: { name: 'Ravi Examplekar', aliases: [], entityType: 'person', purpose: 'bgv', limit: 40, adjudicate: false, displayThreshold: 0.6 },
  summary: { matchCount: matches.length, byBand: { confirmed: 0, probable: 0, possible: matches.length, unlikely: 0 }, highestBand: 'possible', verdict: matches.length ? 'matches_found' : 'no_matches_found', byVerdict: { confirmed: 0, likely: 0, possible: matches.length }, excludedCount: 1 },
  matches,
  relatedButUnverified: [],
  excluded: [{ caseId: 'e1', cnr: 'ZZAB010000022024', reason: 'the record names a different father', identity: { verdict: 'not_this_person', checks: [] } }],
  toVerify: [],
  addressCourts: { district: 'Example', inRecords: true, note: 'Our records include cases from the courts of Example district.' },
  coverage: { exhaustive: true, exhaustiveWithinFilters: true, planClamped: false, anyStrategyErrored: false, strategiesRun: ['original'], someRecordsWithheld: false },
  adjudicationsRun: 0,
  notice: 'notice text',
});
const ARGS = { name: 'Ravi Examplekar', entityType: 'person', purpose: 'bgv' };

test('a screen is compact by default: scoring detail dropped, identity, status, link and the rest kept', async () => {
  await withApi(async () => ok(screen([match(1, { courtRecordActs: [{ act: 'Example Act', sections: ['1'] }] })]), { meta: { creditsCharged: 100 } }), async ({ client }) => {
    const out = json(await client.callTool({ name: 'screen_party_litigation', arguments: ARGS }));
    const m = out.data.matches[0];
    assert.equal(m.evidence, undefined);
    assert.equal(m.rationale, undefined);
    assert.equal(m.petitioners, undefined);
    assert.equal(m.band, 'possible');
    assert.equal(m.status, 'disposed');
    assert.equal(m.identity.verdict, 'possible');
    assert.equal(m.casePageUrl, 'https://example.invalid/case/1');
    assert.deepEqual(m.courtRecordActs, [{ act: 'Example Act', sections: ['1'] }]);
    assert.equal(out.data.excluded[0].reason, 'the record names a different father');
    assert.equal(out.data.addressCourts.inRecords, true);
    assert.equal(out.data.notice, 'notice text');
    assert.equal(out.meta.creditsCharged, 100);
  });
});

test('detail full returns the API response unchanged and is never sent to the API', async () => {
  await withApi(async () => ok(screen([match(1)])), async ({ api, client }) => {
    const out = json(await client.callTool({ name: 'screen_party_litigation', arguments: { ...ARGS, detail: 'full' } }));
    assert.equal(out.data.matches[0].rationale, 'Scored on name similarity plus the supporting evidence listed.');
    assert.equal(api.calls[0].body.detail, undefined);
  });
});

test('compact output is much smaller on a 40 match screen', async () => {
  const many = Array.from({ length: 40 }, (_, i) => match(i));
  await withApi(async () => ok(screen(many)), async ({ client }) => {
    const compact = text(await client.callTool({ name: 'screen_party_litigation', arguments: ARGS }));
    const full = text(await client.callTool({ name: 'screen_party_litigation', arguments: { ...ARGS, detail: 'full' } }));
    assert.ok(compact.length < full.length * 0.6, `compact ${compact.length} vs full ${full.length}`);
  });
});

const ITEMS = [
  { clientRef: 'a', name: 'Ravi Examplekar' },
  { clientRef: 'b', name: 'Asha Examplekar' },
];
const failedItem = (index, clientRef, errorId) => ({ clientRef, index, ok: false, error: { code: 'PARTY_SCREEN_ITEM_FAILED', message: 'Case search could not finish for this item, so it was not charged. Send this item again.', errorId } });
const okItem = (index, clientRef) => ({ clientRef, index, ok: true, screen: screen([match(index)]) });

test('a replayed batch with unfinished items reruns only those items and merges them in place', async () => {
  await withApi(async (call) => {
    if (call.body.items.length === 2) {
      return { ...ok({ results: [okItem(0, 'a'), failedItem(1, 'b', 'err-1')], summary: { items: 2, matchesFound: 1, noMatches: 0, inconclusive: 0, errors: 1 } }, { meta: { creditsCharged: 0, replayed: true } }), headers: { 'idempotency-replayed': 'true' } };
    }
    return ok({ results: [okItem(0, 'b')], summary: { items: 1, matchesFound: 1, noMatches: 0, inconclusive: 0, errors: 0 } }, { meta: { creditsCharged: 100 } });
  }, async ({ api, client }) => {
    const res = await client.callTool({ name: 'screen_party_litigation_batch', arguments: { items: ITEMS, purpose: 'bgv', entityType: 'person' } });
    const out = json(res);
    assert.equal(api.calls.length, 2);
    assert.deepEqual(api.calls[1].body.items, [ITEMS[1]], 'only the unfinished item is sent again');
    assert.notEqual(api.calls[1].headers['idempotency-key'], api.calls[0].headers['idempotency-key']);
    assert.equal(out.data.results[1].ok, true);
    assert.equal(out.data.results[1].index, 1, 'the original index is kept');
    assert.equal(out.data.results[1].clientRef, 'b');
    assert.equal(out.data.summary.errors, 0);
    assert.equal(out.data.summary.matchesFound, 2);
    assert.equal(out.meta.creditsCharged, 100, 'what the rerun charged');
    assert.match(text(res), /screened again now/);
    assert.equal(out.data.results[0].screen.matches[0].evidence, undefined, 'compact as usual');
  });
});

test('a fresh batch with a failed item is not rerun by the client (the server already retried once)', async () => {
  await withApi(async () => ok({ results: [okItem(0, 'a'), failedItem(1, 'b', 'err-2')], summary: { items: 2, matchesFound: 1, noMatches: 0, inconclusive: 0, errors: 1 } }, { meta: { creditsCharged: 100 } }), async ({ api, client }) => {
    const out = json(await client.callTool({ name: 'screen_party_litigation_batch', arguments: { items: ITEMS, purpose: 'bgv', entityType: 'person' } }));
    assert.equal(api.calls.length, 1);
    assert.equal(out.data.results[1].ok, false);
  });
});

test('the tool descriptions explain addressCourts, excluded reasons and the identity verdicts', async () => {
  await withApi(async () => ok({}), async ({ client }) => {
    const { tools } = await client.listTools();
    for (const name of ['screen_party_litigation', 'screen_party_litigation_batch', 'build_party_profile']) {
      const d = tools.find((t) => t.name === name).description;
      assert.match(d, /addressCourts/, name);
      assert.match(d, /excluded/, name);
    }
    const single = tools.find((t) => t.name === 'screen_party_litigation');
    assert.match(single.description, /confirmed[\s\S]*likely[\s\S]*possible/);
    assert.ok(single.inputSchema.properties.detail, 'detail is offered');
    assert.doesNotMatch(tools.map((t) => t.description).join(' '), /[–—]/, 'no em or en dashes');
  });
});

test('a rerun that comes back replayed and still failed gets one more round under a new key', async () => {
  const keys = [];
  await withApi(async (call) => {
    keys.push(call.headers['idempotency-key']);
    const replayed = { headers: { 'idempotency-replayed': 'true' } };
    if (call.body.items.length === 2) {
      return { ...ok({ results: [okItem(0, 'a'), failedItem(1, 'b', 'err-1')], summary: {} }, { meta: { creditsCharged: 0 } }), ...replayed };
    }
    if (keys.length === 2) {
      // The first rerun is itself a replay of an earlier rerun that failed again.
      return { ...ok({ results: [failedItem(0, 'b', 'err-2')], summary: {} }, { meta: { creditsCharged: 0 } }), ...replayed };
    }
    return ok({ results: [okItem(0, 'b')], summary: {} }, { meta: { creditsCharged: 100 } });
  }, async ({ api, client }) => {
    const res = await client.callTool({ name: 'screen_party_litigation_batch', arguments: { items: ITEMS, purpose: 'bgv', entityType: 'person' } });
    const out = json(res);
    assert.equal(api.calls.length, 3);
    assert.notEqual(keys[2], keys[1], 'a new failure gets a new key');
    assert.equal(out.data.results[1].ok, true);
    assert.equal(out.data.results[1].clientRef, 'b');
    assert.equal(out.meta.creditsCharged, 100);
  });
});

test('a company match keeps its evidence in compact mode; a person keeps matchedFields only', async () => {
  const company = match(1, { identity: undefined, evidence: { matchedFields: ['identifier'], signals: [{ name: 'identifier', status: 'matched' }] } });
  await withApi(async () => ok(screen([company, match(2, { evidence: { matchedFields: ['title'], disambiguatorPresent: false, signals: [] } })])), async ({ client }) => {
    const out = json(await client.callTool({ name: 'screen_party_litigation', arguments: ARGS }));
    assert.deepEqual(out.data.matches[0].evidence.signals, [{ name: 'identifier', status: 'matched' }]);
    assert.deepEqual(out.data.matches[1].evidence, { matchedFields: ['title'], disambiguatorPresent: false });
  });
});

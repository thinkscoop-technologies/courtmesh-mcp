/**
 * Tests for the Streamable HTTP transport's admission control.
 *
 * These exist because the HTTP transport is the only part of this package that
 * is reachable by strangers. It used to allocate a session, worth roughly
 * 220 KB of RSS, for any anonymous POST that looked like an initialize, and
 * release it only when the client sent an explicit DELETE. A few thousand
 * unauthenticated requests were therefore enough to exhaust the box.
 *
 * Everything here runs against a real listening process over real HTTP. No
 * mocks, and no network beyond loopback: the upstream CourtMesh API is never
 * called, because none of these requests get as far as a tool invocation.
 *
 * Run: npm test   (build first, these drive dist/index.js)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'dist/index.js');

/** Well formed keys, deliberately fake: nothing here reaches the upstream API. */
const KEY_A = 'cm-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-abcd';
const KEY_B = 'cm-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-wxyz';

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
});
const LIST = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextPort = 41000 + Math.floor(Math.random() * 2000);

/** Start the server with the given env, run fn against its base URL, always kill it. */
async function withServer(env, fn) {
  const port = nextPort++;
  const child = spawn(process.execPath, [ENTRY, '--http'], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i += 1) {
      try {
        up = (await fetch(`${base}/health`)).ok;
      } catch {
        await sleep(100);
      }
    }
    assert.ok(up, 'server did not start');
    await fn(base);
  } finally {
    child.kill('SIGKILL');
  }
}

function headers(key, sessionId) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (key) h.authorization = `Bearer ${key}`;
  if (sessionId) h['mcp-session-id'] = sessionId;
  return h;
}

/** POST one JSON-RPC message and drain the response. */
async function post(base, { key, sessionId, body = INIT, raw } = {}) {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: headers(key, sessionId), body: raw ?? body });
  const text = await res.text();
  return { status: res.status, text, sessionId: res.headers.get('mcp-session-id'), headers: res.headers };
}

async function openSession(base, key) {
  const res = await post(base, { key });
  return res.sessionId;
}

// ---------------------------------------------------------------------------
// Authentication happens before allocation
// ---------------------------------------------------------------------------

test('an anonymous initialize is refused with 401 and allocates nothing', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: INIT,
    });
    const body = await res.text();
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('mcp-session-id'), null, 'no session may be handed to an anonymous caller');
    assert.ok(res.headers.get('www-authenticate'));
    assert.match(body, /"jsonrpc"/);
    assert.match(body, /-32001/);
  });
});

test('a key that cannot be a CourtMesh key is refused without allocating', async () => {
  await withServer({}, async (base) => {
    for (const bad of ['not-a-key', 'cm-short', 'Bearer', 'cm-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-abcde']) {
      const res = await post(base, { key: bad });
      assert.equal(res.status, 401, `${bad} should be refused`);
      assert.equal(res.sessionId, null);
    }
  });
});

test('a well formed key is accepted through either the header or the query parameter', async () => {
  await withServer({}, async (base) => {
    const viaHeader = await post(base, { key: KEY_A });
    assert.equal(viaHeader.status, 200);
    assert.ok(viaHeader.sessionId);

    const res = await fetch(`${base}/mcp?token=${KEY_A}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: INIT,
    });
    await res.text();
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('mcp-session-id'));
  });
});

// ---------------------------------------------------------------------------
// A session belongs to the credential that opened it
// ---------------------------------------------------------------------------

test('a session id alone is not enough to use, stream from, or terminate a session', async () => {
  await withServer({}, async (base) => {
    const sessionId = await openSession(base, KEY_A);

    const owner = await post(base, { key: KEY_A, sessionId, body: LIST });
    assert.equal(owner.status, 200, 'the owner must still be able to use its own session');

    const stranger = await post(base, { key: KEY_B, sessionId, body: LIST });
    assert.equal(stranger.status, 404, 'a stranger holding the id must be told the session does not exist');

    const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: headers(KEY_B, sessionId) });
    await del.text();
    assert.equal(del.status, 404);

    const sse = await fetch(`${base}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream', authorization: `Bearer ${KEY_B}`, 'mcp-session-id': sessionId },
    });
    await sse.body?.cancel();
    assert.equal(sse.status, 404, 'a stranger must not be able to attach to the SSE stream');

    const after = await post(base, { key: KEY_A, sessionId, body: LIST });
    assert.equal(after.status, 200, 'none of the above may have disturbed the real session');
  });
});

test('a foreign session id and an unknown session id are indistinguishable', async () => {
  await withServer({}, async (base) => {
    const sessionId = await openSession(base, KEY_A);
    const foreign = await post(base, { key: KEY_B, sessionId, body: LIST });
    const unknown = await post(base, {
      key: KEY_B,
      sessionId: '00000000-0000-4000-8000-000000000000',
      body: LIST,
    });
    assert.equal(foreign.status, unknown.status);
    assert.equal(foreign.text, unknown.text, 'the refusal must not reveal that the id exists');
  });
});

// ---------------------------------------------------------------------------
// The session map is bounded
// ---------------------------------------------------------------------------

test('the session map is capped, and the least recently used session is evicted', async () => {
  await withServer(
    { MCP_MAX_SESSIONS: '5', MCP_MAX_SESSIONS_PER_KEY: '1000', MCP_INIT_PER_MIN: '100000' },
    async (base) => {
      const ids = [];
      for (let i = 0; i < 8; i += 1) ids.push(await openSession(base, KEY_A));

      const alive = [];
      for (const id of ids) {
        const res = await post(base, { key: KEY_A, sessionId: id, body: LIST });
        if (res.status === 200) alive.push(id);
      }
      assert.equal(alive.length, 5, 'never more than the cap');
      assert.deepEqual(alive, ids.slice(3), 'the survivors are the five most recent');
    },
  );
});

test('one credential cannot occupy the whole map', async () => {
  await withServer(
    { MCP_MAX_SESSIONS: '500', MCP_MAX_SESSIONS_PER_KEY: '3', MCP_INIT_PER_MIN: '100000' },
    async (base) => {
      const ids = [];
      for (let i = 0; i < 10; i += 1) ids.push(await openSession(base, KEY_A));
      let alive = 0;
      for (const id of ids) {
        if ((await post(base, { key: KEY_A, sessionId: id, body: LIST })).status === 200) alive += 1;
      }
      assert.equal(alive, 3);

      // A second credential is unaffected by the first one's churn.
      const other = await post(base, { key: KEY_B });
      assert.equal(other.status, 200);
      assert.ok(other.sessionId);
    },
  );
});

test('session creation is rate limited per client address', async () => {
  await withServer({ MCP_INIT_PER_MIN: '5' }, async (base) => {
    const codes = [];
    for (let i = 0; i < 8; i += 1) codes.push((await post(base, { key: KEY_A })).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429, 429]);
  });
});

test('an idle session is reaped rather than held for the life of the process', async () => {
  await withServer({ MCP_SESSION_IDLE_MS: '800', MCP_SESSION_SWEEP_MS: '200' }, async (base) => {
    const sessionId = await openSession(base, KEY_A);
    assert.equal((await post(base, { key: KEY_A, sessionId, body: LIST })).status, 200);
    await sleep(1600);
    const after = await post(base, { key: KEY_A, sessionId, body: LIST });
    assert.equal(after.status, 404, 'the idle sweep must have closed it');
  });
});

// ---------------------------------------------------------------------------
// Nothing about the deployment is disclosed
// ---------------------------------------------------------------------------

test('a malformed body gets a JSON-RPC parse error, never a stack trace', async () => {
  // NODE_ENV is deliberately NOT production here: the handler, not the
  // environment, is what has to make the disclosure impossible.
  await withServer({ NODE_ENV: 'development' }, async (base) => {
    const res = await post(base, { key: KEY_A, raw: '{not json' });
    assert.equal(res.status, 400);
    assert.match(res.text.trim(), /^\{/, 'must be JSON, not an HTML error page');
    assert.match(res.text, /-32700/);
    assert.doesNotMatch(res.text, /node_modules|at \w+ \(|\/Users\/|\/home\/|\/var\/www/);
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

test('an unknown path is a JSON 404, and health needs no credential', async () => {
  await withServer({ NODE_ENV: 'development' }, async (base) => {
    const nf = await fetch(`${base}/wp-admin/setup-config.php`, { headers: headers(KEY_A) });
    const body = await nf.text();
    assert.equal(nf.status, 404);
    assert.match(body.trim(), /^\{/);
    assert.doesNotMatch(body, /node_modules|\/Users\/|\/home\//);

    const health = await fetch(`${base}/health`);
    const healthBody = await health.json();
    assert.equal(health.status, 200);
    assert.equal(healthBody.status, 'ok');
  });
});
